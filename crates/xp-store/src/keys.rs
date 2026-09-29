//! 外部 AI 用的 API key。每个 AI 一把，主要用来区分“是谁改的”；
//! 库里只存 key 的 SHA-256，明文只在创建时显示一次。

use crate::{Result, Store, StoreError};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

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
            return Err(StoreError::Invalid(format!("已经有叫 {name} 的 key 了")));
        }
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
        match self
            .lock()
            .execute("DELETE FROM api_keys WHERE name = ?1", [name])?
        {
            0 => Err(StoreError::NotFound(format!("没有叫 {name} 的 key"))),
            _ => Ok(()),
        }
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
