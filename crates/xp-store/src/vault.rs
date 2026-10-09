//! 密码库：网站账号、API key、服务器和设备的登录信息。
//!
//! 加密和解密都在界面里做（主密码不离开输入它的那台电脑），这里只存密文：
//! - `vault_keys`：钥匙。主密码经过 scrypt 得到的密钥把「密码库密钥」包起来存在 `data` 里（盐、参数、密文）。
//!   改主密码只是重新包一次。一般只有一把；两台电脑各自设过主密码再合并时会有两把，各解各的条目
//! - `secrets`：条目。名称（`title`）和种类（`kind`）是明文，方便列出和合并；其余内容都在 `data` 的密文里
//!   （`n` 随机数、`c` 密文，都是 base64）
//!
//! 和普通条目分开存，所以不会出现在条目列表、搜索、导出、交给 AI 的内容里。
//! AI 要用某一条时发一个「取用请求」（只在内存里，两分钟过期），用户在界面上点了允许，
//! 界面才把那一条解密、用请求里带的公钥加密后交回来，这里只是转交，看不到内容。
//!
//! 接口在局域网里不用登录，所以改动密码库（改主密码、存、删、批准取用）都要带一个校验值（见 `check_mac`）：
//! 只有解开了密码库的界面算得出来。条目的真名称在密文里面；`title` 列只是给锁着时和 AI 列表看的标签，
//! 界面解开后以密文里的为准（不然别人可以把一条的密文挂到另一个名称下面，骗用户批准）。

use crate::{invalid, log, Result, Store, StoreError};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use xp_core::{new_id, now_ms, str_of};

/// 一条密文最大这么多（base64 之后）
const MAX_SECRET: usize = 256 * 1024;
const MAX_KEY: usize = 8 * 1024;
const MAX_TITLE: usize = 200;
/// 取用请求多久过期（毫秒）
pub const REQUEST_TTL_MS: f64 = 120_000.0;
const MAX_REQUESTS: usize = 5;
pub const KINDS: &[&str] = &["login", "apikey", "server"];
const ACTOR_MERGE: &str = "merge";

/// AI 发来的取用请求（只在内存里）
pub(crate) struct Request {
    secret_id: String,
    title: String,
    actor: String,
    reason: String,
    /// 请求方的公钥：界面用它把内容加密后交回来
    pubkey: String,
    created: f64,
    /// pending / approved / denied
    status: &'static str,
    sealed: Option<Value>,
}

fn conflict(m: impl Into<String>) -> StoreError {
    StoreError::Conflict(m.into())
}

fn valid_id(s: &str) -> bool {
    (4..=40).contains(&s.len())
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

struct Row {
    kid: String,
    title: String,
    kind: String,
    created: f64,
    updated: f64,
    deleted: Option<f64>,
    data: String,
}

impl Row {
    fn alive(&self) -> bool {
        self.deleted.is_none()
    }
    fn changed_at(&self) -> f64 {
        self.updated.max(self.deleted.unwrap_or(0.0))
    }
    fn same(&self, o: &Row) -> bool {
        self.alive() == o.alive()
            && self.kid == o.kid
            && self.title == o.title
            && self.kind == o.kind
            && self.data == o.data
    }
    fn json(&self, id: &str) -> Value {
        let d: Value = serde_json::from_str(&self.data).unwrap_or(Value::Null);
        json!({
            "id": id, "kid": self.kid, "title": self.title, "kind": self.kind,
            "createdAt": self.created, "updatedAt": self.updated,
            "n": d["n"], "c": d["c"],
        })
    }
}

fn read_secret(conn: &Connection, id: &str) -> Result<Option<Row>> {
    Ok(conn
        .query_row(
            "SELECT kid, title, kind, created_at, updated_at, deleted_at, data FROM secrets WHERE id = ?1",
            [id],
            |r| {
                Ok(Row {
                    kid: r.get(0)?,
                    title: r.get(1)?,
                    kind: r.get(2)?,
                    created: r.get(3)?,
                    updated: r.get(4)?,
                    deleted: r.get(5)?,
                    data: r.get(6)?,
                })
            },
        )
        .optional()?)
}

fn all_secrets(conn: &Connection) -> Result<HashMap<String, Row>> {
    let mut q = conn.prepare(
        "SELECT id, kid, title, kind, created_at, updated_at, deleted_at, data FROM secrets",
    )?;
    let rows = q.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            Row {
                kid: r.get(1)?,
                title: r.get(2)?,
                kind: r.get(3)?,
                created: r.get(4)?,
                updated: r.get(5)?,
                deleted: r.get(6)?,
                data: r.get(7)?,
            },
        ))
    })?;
    Ok(rows.collect::<std::result::Result<HashMap<_, _>, _>>()?)
}

fn write_secret(tx: &Connection, id: &str, r: &Row) -> Result<()> {
    tx.execute(
        "INSERT INTO secrets (id, kid, title, kind, created_at, updated_at, deleted_at, data) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(id) DO UPDATE SET kid = excluded.kid, title = excluded.title, kind = excluded.kind, created_at = excluded.created_at,
           updated_at = excluded.updated_at, deleted_at = excluded.deleted_at, data = excluded.data",
        params![id, r.kid, r.title, r.kind, r.created, r.updated, r.deleted, r.data],
    )?;
    Ok(())
}

fn key_exists(conn: &Connection, kid: &str) -> Result<Option<f64>> {
    Ok(conn
        .query_row(
            "SELECT updated_at FROM vault_keys WHERE kid = ?1",
            [kid],
            |r| r.get(0),
        )
        .optional()?)
}

/// 密码库里的时间都取整到毫秒：界面要把它原样放进校验串里，不能有小数
fn ts() -> f64 {
    now_ms().floor()
}

/// 名称、理由这类要显示给人看的字：不许有控制字符（换行等），免得在弹窗里伪装成别的内容
fn has_control(s: &str) -> bool {
    s.chars().any(|c| c.is_control())
}

fn clean(s: &str, max: usize) -> String {
    // 控制字符换成空格；看不见的字符（零宽、改变文字方向的）直接去掉，免得在弹窗里把字排成别的样子
    s.chars()
        .filter(|c| {
            !matches!(*c, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2069}' | '\u{FEFF}')
        })
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .trim()
        .chars()
        .take(max)
        .collect()
}

fn b64d(s: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(s).ok()
}

/// 钥匙的 (updated_at, 校验密钥)
fn key_auth(conn: &Connection, kid: &str) -> Result<Option<(f64, Vec<u8>)>> {
    let row: Option<(f64, String)> = conn
        .query_row(
            "SELECT updated_at, data FROM vault_keys WHERE kid = ?1",
            [kid],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    Ok(row.map(|(at, data)| {
        let v: Value = serde_json::from_str(&data).unwrap_or(Value::Null);
        (at, b64d(str_of(&v, "auth")).unwrap_or_default())
    }))
}

/// 改动密码库要证明自己手里有解开的密码库密钥：界面用从它派生的校验密钥对这次改动的内容算一个 HMAC-SHA256。
/// 接口在局域网里不用登录，没有这一步的话谁都能改掉、删掉密文，或者冒充用户批准取用。
/// 校验串是各部分用换行连起来；重放旧请求会被 expect（上次看到的 updatedAt）挡住，所以 expect 也在里面
fn check_mac(auth: &[u8], parts: &[&str], mac: &str) -> Result<()> {
    use hmac::{Hmac, Mac};
    let deny = || invalid("密码库没解锁，或者这次改动不是从解锁了的界面发来的");
    if auth.len() != 32 {
        return Err(deny());
    }
    let mut m = Hmac::<sha2::Sha256>::new_from_slice(auth).map_err(|_| deny())?;
    m.update(parts.join("\n").as_bytes());
    m.verify_slice(&b64d(mac).ok_or_else(deny)?)
        .map_err(|_| deny())
}

fn stamp(t: Option<f64>) -> String {
    t.map(|x| (x as i64).to_string()).unwrap_or_default()
}

impl Store {
    /// 整个密码库（密文）：钥匙和没删除的条目。界面拿去在本地解密。校验密钥不往外给
    pub fn vault_state(&self) -> Result<Value> {
        let conn = self.lock();
        let mut keys = vec![];
        {
            let mut q = conn.prepare(
                "SELECT kid, created_at, updated_at, data FROM vault_keys ORDER BY created_at, kid",
            )?;
            let rows = q.query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, f64>(1)?,
                    r.get::<_, f64>(2)?,
                    r.get::<_, String>(3)?,
                ))
            })?;
            for row in rows {
                let (kid, created, updated, data) = row?;
                let mut v: Map<String, Value> = serde_json::from_str(&data).unwrap_or_default();
                v.remove("auth");
                v.insert("kid".into(), json!(kid));
                v.insert("createdAt".into(), json!(created));
                v.insert("updatedAt".into(), json!(updated));
                keys.push(Value::Object(v));
            }
        }
        let mut secrets: Vec<(String, Row)> = all_secrets(&conn)?
            .into_iter()
            .filter(|(_, r)| r.alive())
            .collect();
        secrets.sort_by(|a, b| {
            a.1.title
                .to_lowercase()
                .cmp(&b.1.title.to_lowercase())
                .then(a.0.cmp(&b.0))
        });
        let secrets: Vec<Value> = secrets.iter().map(|(id, r)| r.json(id)).collect();
        Ok(json!({ "keys": keys, "secrets": secrets }))
    }

    /// 只有名称和种类（给 AI 看有哪些条目，不含任何密文）
    pub fn vault_index(&self) -> Result<Vec<Value>> {
        let st = self.vault_state()?;
        Ok(st["secrets"]
            .as_array()
            .map(|a| {
                a.iter()
                    .map(|s| json!({ "id": s["id"], "title": s["title"], "kind": s["kind"], "updatedAt": s["updatedAt"] }))
                    .collect()
            })
            .unwrap_or_default())
    }

    /// 新建钥匙（第一次设主密码），或者换掉已有钥匙的内容（改主密码）。
    /// data：kdf、salt、n、c，新建时还要带 auth（校验密钥）。
    /// 改主密码要带 expect（界面看到的 updatedAt）和 mac（用原来的校验密钥算的），校验密钥本身不变
    pub fn vault_put_key(
        &self,
        kid: &str,
        data: &Value,
        expect: Option<f64>,
        mac: &str,
        actor: &str,
    ) -> Result<Value> {
        if !valid_id(kid) {
            return Err(invalid("钥匙的标识不对"));
        }
        let f = |k: &str| str_of(data, k);
        let num = |k: &str| data["kdf"][k].as_u64().unwrap_or(0);
        let ok = data.is_object()
            && [f("salt"), f("n"), f("c")].iter().all(|s| !s.is_empty())
            && data["kdf"]["alg"] == "scrypt"
            && num("N") > 0
            && data.to_string().len() <= MAX_KEY;
        if !ok {
            return Err(invalid("钥匙的内容不对"));
        }
        let now = ts();
        self.write(|tx| {
            match (key_auth(tx, kid)?, expect) {
                (Some((cur, auth)), Some(e)) => {
                    let (n_, r_, p_) = (num("N").to_string(), num("r").to_string(), num("p").to_string());
                    check_mac(
                        &auth,
                        &["put-key", kid, f("salt"), f("n"), f("c"), &n_, &r_, &p_, &stamp(expect)],
                        mac,
                    )?;
                    if cur != e {
                        return Err(conflict("主密码在别处刚改过，请刷新后重新解锁"));
                    }
                    // 校验密钥是从密码库密钥派生的，改主密码不会变：沿用原来的，不信请求里带的
                    let mut d = data.clone();
                    d["auth"] = json!(base64::Engine::encode(
                        &base64::engine::general_purpose::STANDARD,
                        &auth
                    ));
                    tx.execute(
                        "UPDATE vault_keys SET data = ?2, updated_at = ?3 WHERE kid = ?1",
                        params![kid, d.to_string(), now.max(cur + 1.0)],
                    )?;
                    log(tx, actor, "vault", "", None, None, Some("密码库：改了主密码"))?;
                }
                (Some(_), None) => return Err(conflict("密码库已经设过主密码了，请刷新后解锁")),
                (None, Some(_)) => return Err(StoreError::NotFound("没有这把钥匙".into())),
                (None, None) => {
                    let n: i64 =
                        tx.query_row("SELECT COUNT(*) FROM vault_keys", [], |r| r.get(0))?;
                    if n > 0 {
                        return Err(conflict("密码库已经设过主密码了，请刷新后解锁"));
                    }
                    if b64d(f("auth")).map(|a| a.len()) != Some(32) {
                        return Err(invalid("钥匙的内容不对"));
                    }
                    tx.execute(
                        "INSERT INTO vault_keys (kid, created_at, updated_at, data) VALUES (?1, ?2, ?2, ?3)",
                        params![kid, now, data.to_string()],
                    )?;
                    log(tx, actor, "vault", "", None, None, Some("密码库：设置了主密码"))?;
                }
            }
            Ok(())
        })?;
        self.vault_state()
    }

    /// 新建或修改一条。body：kid、title、kind、n、c、mac，改已有的要带 expect（界面看到的 updatedAt）
    pub fn vault_put_secret(&self, id: &str, body: &Value, actor: &str) -> Result<Value> {
        if !valid_id(id) {
            return Err(invalid("条目的标识不对"));
        }
        let title = str_of(body, "title");
        if title.is_empty()
            || title != title.trim()
            || has_control(title)
            || title.chars().count() > MAX_TITLE
        {
            return Err(invalid("名称不能为空、不能换行，也不能超过 200 个字"));
        }
        let kind = str_of(body, "kind");
        if !KINDS.contains(&kind) {
            return Err(invalid("种类只能是 login、apikey、server"));
        }
        let (n, c) = (str_of(body, "n"), str_of(body, "c"));
        if n.is_empty() || c.is_empty() || c.len() > MAX_SECRET {
            return Err(invalid("内容不对或太大"));
        }
        let kid = str_of(body, "kid");
        let expect = body.get("expect").and_then(|v| v.as_f64());
        let now = ts();
        let data = json!({ "n": n, "c": c }).to_string();
        let (out, _) = self.write(|tx| {
            let (_, auth) =
                key_auth(tx, kid)?.ok_or_else(|| invalid("没有这把钥匙，请刷新后重新解锁"))?;
            check_mac(
                &auth,
                &["put-secret", id, kid, title, kind, n, c, &stamp(expect)],
                str_of(body, "mac"),
            )?;
            let cur = read_secret(tx, id)?;
            let row = match (&cur, expect) {
                (Some(c), Some(e)) if c.alive() && c.updated == e => {
                    // 换钥匙要证明两把都解开了，这里不支持：原来哪把还是哪把
                    if c.kid != kid {
                        return Err(invalid("这一条是用另一把钥匙加密的"));
                    }
                    Row {
                        kid: kid.to_string(),
                        title: title.to_string(),
                        kind: kind.to_string(),
                        created: c.created,
                        updated: now.max(c.updated + 1.0),
                        deleted: None,
                        data,
                    }
                }
                (Some(c), Some(_)) if !c.alive() => {
                    return Err(StoreError::NotFound("这一条已经被删除了".into()));
                }
                // 已经有了（包括删掉的：标识不重复用，免得旧请求把删掉的又写回来）
                (Some(_), _) => {
                    return Err(conflict("这一条在别处刚改过，请刷新后再改"));
                }
                (None, Some(_)) => {
                    return Err(StoreError::NotFound("这一条已经被删除了".into()));
                }
                (None, None) => Row {
                    kid: kid.to_string(),
                    title: title.to_string(),
                    kind: kind.to_string(),
                    created: now,
                    updated: now,
                    deleted: None,
                    data,
                },
            };
            write_secret(tx, id, &row)?;
            let what = if cur.is_some() { "改了" } else { "新建" };
            log(
                tx,
                actor,
                "vault",
                "",
                None,
                None,
                Some(&format!("密码库：{what}「{}」", row.title)),
            )?;
            Ok(row.json(id))
        })?;
        Ok(out)
    }

    /// 删除一条（软删除：合并时别的电脑也会删掉）。expect 是界面看到的 updatedAt
    pub fn vault_delete_secret(&self, id: &str, expect: f64, mac: &str, actor: &str) -> Result<()> {
        let now = ts();
        self.write(|tx| {
            let cur = read_secret(tx, id)?
                .filter(|r| r.alive())
                .ok_or_else(|| StoreError::NotFound("没有这一条".into()))?;
            let (_, auth) = key_auth(tx, &cur.kid)?.unwrap_or_default();
            check_mac(&auth, &["delete-secret", id, &stamp(Some(expect))], mac)?;
            if cur.updated != expect {
                return Err(conflict("这一条在别处刚改过，请刷新后再删"));
            }
            tx.execute(
                "UPDATE secrets SET deleted_at = ?2 WHERE id = ?1",
                params![id, now.max(cur.updated + 1.0)],
            )?;
            log(
                tx,
                actor,
                "vault",
                "",
                None,
                None,
                Some(&format!("密码库：删除了「{}」", cur.title)),
            )
        })?;
        Ok(())
    }

    // ------------------------------------------------------------ 取用请求

    fn requests(&self) -> std::sync::MutexGuard<'_, HashMap<String, Request>> {
        let mut g = self
            .vault_requests
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let now = now_ms();
        g.retain(|_, r| now - r.created < REQUEST_TTL_MS + 30_000.0);
        g
    }

    /// AI 请求取用一条。pubkey 是请求方的临时公钥，内容会用它加密后交回。
    /// actor 必须是用 API key 验证过的名字（接口那一层保证）
    pub fn vault_request_create(
        &self,
        secret_id: &str,
        reason: &str,
        pubkey: &str,
        actor: &str,
    ) -> Result<Value> {
        let row = read_secret(&self.lock(), secret_id)?
            .filter(|r| r.alive())
            .ok_or_else(|| StoreError::NotFound("密码库里没有这一条，先用列表看看有哪些".into()))?;
        if b64d(pubkey).map(|p| p.len()) != Some(32) {
            return Err(invalid("pub 不对：要 32 字节 X25519 公钥的 base64"));
        }
        let actor = clean(actor, 40);
        let mut g = self.requests();
        let now = now_ms();
        let live = |r: &Request| r.status == "pending" && now - r.created < REQUEST_TTL_MS;
        if g.values()
            .any(|r| live(r) && r.actor == actor && r.secret_id == secret_id)
        {
            return Err(conflict(
                "同一条已经有一个请求在等用户确认，等它有结果（或两分钟后作废）再说",
            ));
        }
        if g.values().filter(|r| live(r)).count() >= MAX_REQUESTS {
            return Err(StoreError::Unavailable(
                "等用户确认的取用请求太多了，稍后再试".into(),
            ));
        }
        let id = new_id();
        g.insert(
            id.clone(),
            Request {
                secret_id: secret_id.to_string(),
                title: row.title,
                actor,
                reason: clean(reason, 300),
                pubkey: pubkey.to_string(),
                created: now,
                status: "pending",
                sealed: None,
            },
        );
        Ok(json!({ "id": id, "status": "pending", "expiresAt": now + REQUEST_TTL_MS }))
    }

    /// 等用户确认的请求（界面据此弹窗）。left 是还剩多少毫秒（各台电脑的钟不一定准，不给绝对时间）
    pub fn vault_requests_pending(&self) -> Vec<Value> {
        let now = now_ms();
        let g = self.requests();
        let mut v: Vec<(f64, Value)> = g
            .iter()
            .filter(|(_, r)| r.status == "pending" && now - r.created < REQUEST_TTL_MS)
            .map(|(id, r)| {
                (
                    r.created,
                    json!({
                        "id": id, "secretId": r.secret_id, "title": r.title, "actor": r.actor,
                        "reason": r.reason, "pub": r.pubkey, "left": REQUEST_TTL_MS - (now - r.created),
                    }),
                )
            })
            .collect();
        v.sort_by(|a, b| a.0.total_cmp(&b.0));
        v.into_iter().map(|x| x.1).collect()
    }

    /// 请求方来问结果：pending / approved（带加密后的内容，取走就没了）/ denied / expired
    pub fn vault_request_get(&self, id: &str) -> Result<Value> {
        let mut g = self.requests();
        let r = g
            .get(id)
            .ok_or_else(|| StoreError::NotFound("没有这个请求，或者已经过期".into()))?;
        let (status, expired) = (r.status, now_ms() - r.created >= REQUEST_TTL_MS);
        match status {
            "approved" => {
                let r = g.remove(id).expect("刚查到");
                Ok(json!({ "status": "approved", "title": r.title, "sealed": r.sealed }))
            }
            "denied" => {
                g.remove(id);
                Ok(json!({ "status": "denied" }))
            }
            _ if expired => {
                g.remove(id);
                Ok(json!({ "status": "expired" }))
            }
            _ => Ok(json!({ "status": "pending" })),
        }
    }

    /// 用户的决定。允许时 sealed 是界面用请求方公钥加密好的内容，mac 证明界面确实解开了这一条的钥匙
    /// （不然局域网里谁都能冒充用户「允许」，塞给 AI 一份假的内容）。拒绝不用证明：最坏也只是 AI 拿不到
    pub fn vault_request_resolve(
        &self,
        id: &str,
        approve: bool,
        sealed: Option<Value>,
        mac: &str,
        actor: &str,
    ) -> Result<()> {
        let gone = || StoreError::NotFound("这个请求已经过期，或者在别处处理过了".into());
        let live = |r: &Request| r.status == "pending" && now_ms() - r.created < REQUEST_TTL_MS;
        let secret_id = {
            let g = self.requests();
            g.get(id)
                .filter(|r| live(r))
                .ok_or_else(gone)?
                .secret_id
                .clone()
        };
        let checked = if approve {
            let s = sealed
                .filter(|s| {
                    ["epk", "n", "c"]
                        .iter()
                        .all(|k| s[k].as_str().is_some_and(|x| !x.is_empty()))
                        && s.to_string().len() <= MAX_SECRET * 2
                })
                .ok_or_else(|| invalid("缺少加密后的内容"))?;
            let conn = self.lock();
            let row = read_secret(&conn, &secret_id)?
                .filter(|r| r.alive())
                .ok_or_else(|| StoreError::NotFound("这一条已经不在密码库里了".into()))?;
            let (_, auth) = key_auth(&conn, &row.kid)?.unwrap_or_default();
            check_mac(
                &auth,
                &[
                    "resolve",
                    id,
                    str_of(&s, "epk"),
                    str_of(&s, "n"),
                    str_of(&s, "c"),
                ],
                mac,
            )?;
            Some(s)
        } else {
            None
        };
        let (title, who) = {
            let mut g = self.requests();
            let r = g.get_mut(id).filter(|r| live(r)).ok_or_else(gone)?;
            r.status = if checked.is_some() {
                "approved"
            } else {
                "denied"
            };
            r.sealed = checked;
            (r.title.clone(), r.actor.clone())
        };
        let what = if approve { "允许" } else { "拒绝" };
        self.write(|tx| {
            log(
                tx,
                actor,
                "vault",
                "",
                None,
                None,
                Some(&format!("密码库：{what} {who} 取用「{title}」")),
            )
        })?;
        Ok(())
    }
}

// ---------------------------------------------------------------- 合并

/// 从外置硬盘合并时带上密码库。r 是外置硬盘上那份，base 是可用的同步点（没有就是 None）。
/// - 钥匙：本机没有的加进来；两边都有的用较新的（改过主密码的）
/// - 条目：只有一边改过的用改过的那边；两边都改过（或没有同步点而内容不同）时留较新的，
///   较旧的那份另存成一条，名称后面带「（合并时保留的旧版本）」，不丢任何一份
pub(crate) fn merge_vault(
    tx: &Connection,
    r: &Connection,
    base: Option<&Connection>,
) -> Result<Value> {
    let mut keys = 0;
    {
        let mut q = r.prepare("SELECT kid, created_at, updated_at, data FROM vault_keys")?;
        let rows = q.query_map([], |x| {
            Ok((
                x.get::<_, String>(0)?,
                x.get::<_, f64>(1)?,
                x.get::<_, f64>(2)?,
                x.get::<_, String>(3)?,
            ))
        })?;
        for row in rows {
            let (kid, created, updated, data) = row?;
            match key_exists(tx, &kid)? {
                None => {
                    keys += tx.execute(
                        "INSERT INTO vault_keys (kid, created_at, updated_at, data) VALUES (?1, ?2, ?3, ?4)",
                        params![kid, created, updated, data],
                    )?;
                }
                // 同一把钥匙：较新的是改过主密码的。校验密钥是从密码库密钥派生的，改主密码不会变；
                // 那边的和本机的不一样，说明那份不是这把钥匙正常改出来的（被人动过），不要
                Some(cur) if updated > cur => {
                    let theirs: Value = serde_json::from_str(&data).unwrap_or(Value::Null);
                    let mine = key_auth(tx, &kid)?.map(|x| x.1).unwrap_or_default();
                    if b64d(str_of(&theirs, "auth")).is_some_and(|a| a == mine) {
                        keys += tx.execute(
                            "UPDATE vault_keys SET data = ?2, updated_at = ?3 WHERE kid = ?1",
                            params![kid, data, updated],
                        )?;
                    }
                }
                _ => {}
            }
        }
    }
    let remote = all_secrets(r)?;
    let local = all_secrets(tx)?;
    let base = match base {
        Some(b) => Some(all_secrets(b)?),
        None => None,
    };
    let (mut changed, mut kept_old) = (0, 0);
    let now = ts();
    for (id, rr) in &remote {
        let Some(l) = local.get(id) else {
            write_secret(tx, id, rr)?;
            changed += usize::from(rr.alive());
            continue;
        };
        if l.same(rr) {
            continue;
        }
        let bb = base.as_ref().and_then(|b| b.get(id));
        if bb.is_some_and(|b| b.same(rr)) {
            continue; // 外置硬盘那边没改，是本机改的
        }
        let only_remote = bb.is_some_and(|b| b.same(l));
        let take_remote = only_remote || rr.changed_at() >= l.changed_at();
        if !only_remote {
            // 两边都改过：输的那份还在的话另存一条
            let loser = if take_remote { l } else { rr };
            if loser.alive() {
                let copy = Row {
                    kid: loser.kid.clone(),
                    title: format!("{}（合并时保留的旧版本）", loser.title),
                    kind: loser.kind.clone(),
                    created: now,
                    updated: now,
                    deleted: None,
                    data: loser.data.clone(),
                };
                write_secret(tx, &new_id(), &copy)?;
                kept_old += 1;
            }
        }
        if take_remote {
            write_secret(tx, id, rr)?;
            changed += 1;
        }
    }
    if keys + changed + kept_old > 0 {
        log(
            tx,
            ACTOR_MERGE,
            "vault",
            "",
            None,
            None,
            Some(&format!(
                "密码库：合并了 {changed} 条，另存了 {kept_old} 份旧版本"
            )),
        )?;
    }
    Ok(json!({ "keys": keys, "secrets": changed, "keptOld": kept_old }))
}
