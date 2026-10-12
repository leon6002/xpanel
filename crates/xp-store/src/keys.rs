//! API key（也叫令牌）。两种用法：
//! - 外部 AI、脚本带着它调接口（`Authorization: Bearer`），用来区分“是谁改的”；
//! - 主机打开「局域网访问要令牌」后，别的电脑和浏览器要带一把才能用（见 xp-server 的 gate.rs）。
//!
//! 库里只存 key 的 SHA-256，明文只在创建时显示一次。

use crate::{Result, Store, StoreError};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::atomic::Ordering;

/// 局域网访问的权限，存在 meta 表的 `access`（只有主机本机能改）
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Access {
    /// 别的电脑和浏览器要带令牌（本机自己访问不用）
    pub require_token: bool,
    /// 带令牌的可以叫这台主机上的 AI（只有开了令牌才能打开）
    pub remote_ai: bool,
}

fn hash(key: &str) -> String {
    Sha256::digest(key.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn valid_name(n: &str) -> bool {
    !n.is_empty()
        && n.chars().count() <= 40
        && !n.contains(char::is_control)
        && n != crate::ACTOR_UI
}

impl Store {
    /// 新建一把 key，返回明文（只这一次能看到）
    pub fn create_key(&self, name: &str) -> Result<String> {
        let name = name.trim();
        if !valid_name(name) {
            return Err(StoreError::Invalid(
                "名字不能为空、不能超过 40 个字，也不能叫 ui".into(),
            ));
        }
        let mut b = [0u8; 24];
        getrandom::getrandom(&mut b).map_err(|e| StoreError::Unavailable(e.to_string()))?;
        let key = format!(
            "xp_{}",
            b.iter().map(|x| format!("{x:02x}")).collect::<String>()
        );
        let n = self.lock().execute(
            "INSERT OR IGNORE INTO api_keys(name, key_hash, created_at) VALUES (?1, ?2, ?3)",
            params![name, hash(&key), xp_core::now_ms()],
        )?;
        if n == 0 {
            return Err(StoreError::Invalid(format!("已经有叫 {name} 的令牌了")));
        }
        self.bump_access();
        Ok(key)
    }

    pub fn list_keys(&self) -> Result<Vec<Value>> {
        let conn = self.lock();
        let mut q =
            conn.prepare("SELECT name, created_at, last_used FROM api_keys ORDER BY created_at")?;
        let rows = q.query_map([], |r| {
            Ok(json!({"name": r.get::<_, String>(0)?, "createdAt": r.get::<_, f64>(1)?, "lastUsed": r.get::<_, Option<f64>>(2)?}))
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn delete_key(&self, name: &str) -> Result<()> {
        let n = self
            .lock()
            .execute("DELETE FROM api_keys WHERE name = ?1", [name])?;
        if n == 0 {
            return Err(StoreError::NotFound(format!("没有叫 {name} 的令牌")));
        }
        self.bump_access();
        // 删光了就没法带令牌访问了：一起把要令牌关掉，免得别的电脑全都进不来又没地方拿令牌
        if self.list_keys()?.is_empty() && self.access()?.require_token {
            self.set_access(Access::default())?;
        }
        Ok(())
    }

    fn bump_access(&self) {
        self.access_gen.fetch_add(1, Ordering::SeqCst);
    }

    /// 令牌或权限变过几次（只在这个进程里算；别的进程改的靠缓存过期）
    pub fn access_gen(&self) -> u64 {
        self.access_gen.load(Ordering::SeqCst)
    }

    pub fn access(&self) -> Result<Access> {
        let raw: Option<String> = self
            .lock()
            .query_row("SELECT value FROM meta WHERE key = 'access'", [], |r| {
                r.get(0)
            })
            .optional()?;
        Ok(raw
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default())
    }

    /// 改权限。要令牌之前得先有一把；叫 AI 只能在要令牌时打开
    pub fn set_access(&self, a: Access) -> Result<Access> {
        if a.require_token && self.list_keys()?.is_empty() {
            return Err(StoreError::Invalid(
                "先生成一个令牌，再打开「要令牌」".into(),
            ));
        }
        let a = Access {
            remote_ai: a.remote_ai && a.require_token,
            ..a
        };
        let v = serde_json::to_string(&a).map_err(|e| StoreError::Invalid(e.to_string()))?;
        self.lock().execute(
            "INSERT INTO meta (key, value) VALUES ('access', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [v],
        )?;
        self.bump_access();
        Ok(a)
    }

    /// 校验 key，返回它的名字；顺便记下最后使用时间
    pub fn verify_key(&self, key: &str) -> Result<Option<String>> {
        let conn = self.lock();
        let h = hash(key.trim());
        let name: Option<String> = conn
            .query_row("SELECT name FROM api_keys WHERE key_hash = ?1", [&h], |r| {
                r.get(0)
            })
            .optional()?;
        if name.is_some() {
            let _ = conn.execute(
                "UPDATE api_keys SET last_used = ?1 WHERE key_hash = ?2",
                params![xp_core::now_ms(), h],
            );
        }
        Ok(name)
    }
}
