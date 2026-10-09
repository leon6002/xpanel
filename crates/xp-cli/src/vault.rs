//! 从密码库取用一条：发请求 → 等用户在界面上点允许 → 解开交回来的内容。
//!
//! 内容在路上是加密的：这里生成一对临时的 X25519 密钥，公钥随请求发过去，界面用它
//! （X25519 + HKDF-SHA256 + XChaCha20-Poly1305）把那一条加密后交给主机转交，主机和局域网上都看不到明文。

use crate::Client;
use base64::Engine;
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use serde_json::{json, Value};
use sha2::Sha256;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use x25519_dalek::{PublicKey, StaticSecret};

const INFO: &[u8] = b"xpanel-vault-request-v1";
/// 一次调用最多等这么久（AI 工具调用有自己的超时），没等到就把请求号交回去，下次接着等
const WAIT: Duration = Duration::from_secs(45);

/// 还在等用户确认的请求：请求号 → 这次请求的临时私钥（只在这个进程的内存里）
static PENDING: Mutex<Option<HashMap<String, [u8; 32]>>> = Mutex::new(None);

fn b64() -> base64::engine::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

fn unb64(v: &Value, k: &str) -> Result<Vec<u8>, String> {
    b64()
        .decode(v[k].as_str().unwrap_or(""))
        .map_err(|_| "交回来的内容格式不对".to_string())
}

/// 用临时私钥解开界面交回来的内容
fn open(sk: &[u8; 32], sealed: &Value) -> Result<Value, String> {
    let bad = || "解不开交回来的内容（可能不是给这次请求的）".to_string();
    let secret = StaticSecret::from(*sk);
    let pk = PublicKey::from(&secret);
    let epk: [u8; 32] = unb64(sealed, "epk")?.try_into().map_err(|_| bad())?;
    let nonce = unb64(sealed, "n")?;
    if nonce.len() != 24 {
        return Err(bad());
    }
    let shared = secret.diffie_hellman(&PublicKey::from(epk));
    let mut salt = [0u8; 64];
    salt[..32].copy_from_slice(&epk);
    salt[32..].copy_from_slice(pk.as_bytes());
    let mut key = [0u8; 32];
    Hkdf::<Sha256>::new(Some(&salt), shared.as_bytes())
        .expand(INFO, &mut key)
        .map_err(|_| bad())?;
    let plain = XChaCha20Poly1305::new((&key).into())
        .decrypt(XNonce::from_slice(&nonce), unb64(sealed, "c")?.as_slice())
        .map_err(|_| bad())?;
    serde_json::from_slice(&plain).map_err(|_| bad())
}

pub fn list(c: &Client) -> Result<Value, String> {
    c.get("/vault/index", &[])
}

fn take(id: &str) -> Option<[u8; 32]> {
    PENDING
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_mut()
        .and_then(|m| m.remove(id))
}

/// 发请求（或接着等 request_id 那个），等用户确认。
/// 返回 Ok(Ok(内容)) 或 Ok(Err(请求号))：还在等，带着请求号再来
pub fn get(
    c: &Client,
    secret_id: Option<&str>,
    reason: &str,
    request_id: Option<&str>,
) -> Result<Result<Value, String>, String> {
    let (rid, sk) = match request_id {
        Some(r) => (
            r.to_string(),
            take(r).ok_or("没有这个请求号（过期了，或者不是这次会话发的），重新请求一次")?,
        ),
        None => {
            let id = secret_id.ok_or("缺少参数 id（先用 xpanel_vault_list 看有哪些）")?;
            let mut sk = [0u8; 32];
            getrandom::getrandom(&mut sk).map_err(|e| format!("生成临时密钥失败：{e}"))?;
            let pk = PublicKey::from(&StaticSecret::from(sk));
            let r = c.send(
                "POST",
                "/vault/requests",
                json!({ "secretId": id, "reason": reason, "pub": b64().encode(pk.as_bytes()) }),
            )?;
            (
                r["id"].as_str().ok_or("xpanel 没有返回请求号")?.to_string(),
                sk,
            )
        }
    };
    let until = Instant::now() + WAIT;
    loop {
        let r = c.get(&format!("/vault/requests/{rid}"), &[])?;
        match r["status"].as_str().unwrap_or("") {
            "approved" => return open(&sk, &r["sealed"]).map(Ok),
            "denied" => return Err("用户拒绝了这次取用。不要重复请求，先问用户".into()),
            "pending" if Instant::now() < until => std::thread::sleep(Duration::from_secs(1)),
            "pending" => {
                PENDING
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .get_or_insert_with(HashMap::new)
                    .insert(rid.clone(), sk);
                return Ok(Err(rid));
            }
            _ => {
                return Err(
                    "两分钟内没有人在 xpanel 里确认，请求作废了。请用户打开 xpanel 后再试".into(),
                )
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 和界面（web/src/lib/vault.ts 的 seal）用同一套算法：这里按同样的步骤加密一份，再解开
    #[test]
    fn opens_what_the_ui_seals() {
        let sk = [7u8; 32];
        let pk = PublicKey::from(&StaticSecret::from(sk));
        let esk = StaticSecret::from([9u8; 32]);
        let epk = PublicKey::from(&esk);
        let shared = esk.diffie_hellman(&pk);
        let mut salt = [0u8; 64];
        salt[..32].copy_from_slice(epk.as_bytes());
        salt[32..].copy_from_slice(pk.as_bytes());
        let mut key = [0u8; 32];
        Hkdf::<Sha256>::new(Some(&salt), shared.as_bytes())
            .expand(INFO, &mut key)
            .unwrap();
        let nonce = [3u8; 24];
        let c = XChaCha20Poly1305::new((&key).into())
            .encrypt(
                XNonce::from_slice(&nonce),
                br#"{"password":"hunter2"}"#.as_slice(),
            )
            .unwrap();
        let sealed = json!({ "epk": b64().encode(epk.as_bytes()), "n": b64().encode(nonce), "c": b64().encode(&c) });
        assert_eq!(open(&sk, &sealed).unwrap()["password"], "hunter2");
        // 别人的私钥解不开；内容被改过也解不开
        assert!(open(&[8u8; 32], &sealed).is_err());
        let mut bad = sealed.clone();
        bad["c"] = json!(b64().encode([c.as_slice(), b"x"].concat()));
        assert!(open(&sk, &bad).is_err());
    }
}
