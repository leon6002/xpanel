//! 设备表。条目的 `device` 字段存设备名字，所以改名时要把条目一起改掉。

use crate::{invalid, log, read_row, write_row, Result, Store, StoreError};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Map, Value};
use xp_core::device::{apply_device_patch, apply_heartbeat, new_device, Heartbeat};
use xp_core::{id_of, new_id, now_ms, str_of};

fn read_device(conn: &Connection, id: &str) -> Result<Option<(Value, bool)>> {
    let r = conn
        .query_row(
            "SELECT data, deleted_at FROM devices WHERE id = ?1",
            [id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<f64>>(1)?)),
        )
        .optional()?;
    Ok(r.map(|(s, d)| (serde_json::from_str(&s).unwrap_or(Value::Null), d.is_some())))
}

fn write_device(conn: &Connection, d: &Value, deleted_at: Option<f64>) -> Result<()> {
    let id = id_of(d).ok_or_else(|| invalid("设备缺少 id"))?;
    conn.execute(
        "INSERT INTO devices (id, name, last_seen, created_at, updated_at, deleted_at, data) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, last_seen = excluded.last_seen, created_at = excluded.created_at,
           updated_at = excluded.updated_at, deleted_at = excluded.deleted_at, data = excluded.data",
        params![
            id,
            str_of(d, "name"),
            d.get("lastSeen").and_then(|x| x.as_f64()),
            d.get("createdAt").and_then(|x| x.as_f64()).unwrap_or(0.0),
            d.get("updatedAt").and_then(|x| x.as_f64()).unwrap_or(0.0),
            deleted_at,
            d.to_string()
        ],
    )?;
    Ok(())
}

/// 名字是否被别的（未删除的）设备占用
fn name_taken(conn: &Connection, name: &str, except: &str) -> Result<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM devices WHERE name = ?1 AND id != ?2 AND deleted_at IS NULL",
            params![name, except],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

/// 找一个没被占用的名字：BASE、BASE-2、BASE-3…
fn free_name(conn: &Connection, base: &str, except: &str) -> Result<String> {
    let base: String = base
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '@' && *c != '#')
        .take(36)
        .collect();
    let base = if base.is_empty() {
        "设备".to_string()
    } else {
        base
    };
    let mut name = base.clone();
    let mut i = 2;
    while name_taken(conn, &name, except)? {
        name = format!("{base}-{i}");
        i += 1;
    }
    Ok(name)
}

fn kind_for_os(os: &str) -> &'static str {
    match os.to_lowercase().as_str() {
        s if s.contains("mac") => "mac",
        s if s.contains("linux") => "server",
        _ => "other",
    }
}

impl Store {
    /// 未删除的设备，按 sort、创建时间排序
    pub fn list_devices(&self) -> Result<Vec<Value>> {
        let conn = self.lock();
        list_devices(&conn)
    }

    pub fn get_device(&self, id: &str) -> Result<Value> {
        match read_device(&self.lock(), id)? {
            Some((d, false)) => Ok(d),
            _ => Err(StoreError::NotFound(format!("找不到设备 {id}"))),
        }
    }

    pub fn create_device(&self, input: &Map<String, Value>, actor: &str) -> Result<Value> {
        let now = now_ms();
        let (d, _) = self.write(|tx| {
            let id = input
                .get("id")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(String::from)
                .unwrap_or_else(new_id);
            if read_device(tx, &id)?.is_some() {
                return Err(invalid(format!("设备 id {id} 已存在")));
            }
            let d = new_device(&id, input, now).map_err(invalid)?;
            if name_taken(tx, str_of(&d, "name"), &id)? {
                return Err(invalid(format!("已经有叫 {} 的设备了", str_of(&d, "name"))));
            }
            write_device(tx, &d, None)?;
            log(tx, actor, "create-device", &id, None, Some(&d), None)?;
            Ok(d)
        })?;
        Ok(d)
    }

    /// 修改设备；改名时把条目里的旧名字一起改掉
    pub fn update_device(
        &self,
        id: &str,
        patch: &Map<String, Value>,
        actor: &str,
    ) -> Result<Value> {
        let now = now_ms();
        let (d, _) = self.write(|tx| {
            let (before, deleted) = read_device(tx, id)?
                .ok_or_else(|| StoreError::NotFound(format!("找不到设备 {id}")))?;
            if deleted {
                return Err(StoreError::NotFound(format!("找不到设备 {id}")));
            }
            let mut d = before.clone();
            apply_device_patch(&mut d, patch, now).map_err(invalid)?;
            let (old, new) = (
                str_of(&before, "name").to_string(),
                str_of(&d, "name").to_string(),
            );
            if old != new {
                if name_taken(tx, &new, id)? {
                    return Err(invalid(format!("已经有叫 {new} 的设备了")));
                }
                let n = rename_in_items(tx, &old, &new)?;
                log(
                    tx,
                    actor,
                    "rename-device",
                    id,
                    None,
                    None,
                    Some(&format!("{old} → {new}，条目 {n} 条")),
                )?;
            }
            write_device(tx, &d, None)?;
            log(
                tx,
                actor,
                "update-device",
                id,
                Some(&before),
                Some(&d),
                None,
            )?;
            Ok(d)
        })?;
        Ok(d)
    }

    /// 软删除。条目里的设备名保留（变成普通文字）
    pub fn delete_device(&self, id: &str, actor: &str) -> Result<()> {
        self.write(|tx| match read_device(tx, id)? {
            Some((d, false)) => {
                write_device(tx, &d, Some(now_ms()))?;
                log(tx, actor, "delete-device", id, Some(&d), None, None)
            }
            _ => Err(StoreError::NotFound(format!("找不到设备 {id}"))),
        })?;
        Ok(())
    }

    /// 桌面版的心跳。设备不存在就按主机名新建；已删除的会恢复（它还活着）。
    /// 只有在线状态或上报内容变了才 rev +1，平时只更新最后在线时间，不打扰界面。
    pub fn heartbeat(&self, hb: &Heartbeat) -> Result<Value> {
        if hb.id.trim().is_empty() {
            return Err(invalid("心跳缺少设备 id"));
        }
        let now = now_ms();
        let existing = read_device(&self.lock(), &hb.id)?;
        match existing {
            Some((mut d, false)) => {
                if apply_heartbeat(&mut d, hb, now) {
                    let d2 = d.clone();
                    self.write(move |tx| write_device(tx, &d2, None))?;
                } else {
                    write_device(&self.lock(), &d, None)?;
                }
                Ok(d)
            }
            other => {
                let (d, _) = self.write(|tx| {
                    let mut d = match other {
                        Some((mut d, true)) => {
                            let name = free_name(tx, str_of(&d, "name"), &hb.id)?;
                            d["name"] = json!(name);
                            d
                        }
                        _ => {
                            let name = free_name(tx, &hb.hostname, &hb.id)?;
                            let mut input = Map::new();
                            input.insert("name".into(), json!(name));
                            input.insert("kind".into(), json!(kind_for_os(&hb.os)));
                            new_device(&hb.id, &input, now).map_err(invalid)?
                        }
                    };
                    apply_heartbeat(&mut d, hb, now);
                    write_device(tx, &d, None)?;
                    log(
                        tx,
                        &format!("device:{}", str_of(&d, "name")),
                        "register-device",
                        &hb.id,
                        None,
                        None,
                        None,
                    )?;
                    Ok(d)
                })?;
                Ok(d)
            }
        }
    }

    /// 升级时，从条目里已经用过的设备名（v1 写死的 台式机 / 笔记本 / Mac）建出设备记录，只做一次
    pub(crate) fn seed_devices(&self) -> Result<()> {
        let mut conn = self.lock();
        let done: Option<String> = conn
            .query_row(
                "SELECT value FROM meta WHERE key = 'devices_seeded'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        if done.is_some() {
            return Ok(());
        }
        let tx = conn.transaction()?;
        let names: Vec<String> = {
            let mut q =
                tx.prepare("SELECT DISTINCT device FROM items WHERE device != '' ORDER BY device")?;
            let rows = q.query_map([], |r| r.get::<_, String>(0))?;
            rows.collect::<std::result::Result<Vec<_>, _>>()?
        };
        let now = now_ms();
        for (i, name) in names.iter().enumerate() {
            if name_taken(&tx, name, "")? {
                continue;
            }
            let mut input = Map::new();
            input.insert("name".into(), json!(name));
            input.insert("sort".into(), json!(i));
            // 旧名字可能带空格等不合规字符，这种就原样当名字存（能匹配上条目最要紧）
            let d = new_device(&new_id(), &input, now).unwrap_or_else(|_| {
                json!({"id": new_id(), "name": name, "kind": xp_core::device::guess_kind(name), "description": "", "aliases": [], "networks": [], "projects": [], "sort": i, "createdAt": now, "updatedAt": now})
            });
            write_device(&tx, &d, None)?;
        }
        tx.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES ('devices_seeded', ?1)",
            [now.to_string()],
        )?;
        tx.commit()?;
        Ok(())
    }
}

pub(crate) fn list_devices(conn: &Connection) -> Result<Vec<Value>> {
    let mut q = conn.prepare("SELECT data FROM devices WHERE deleted_at IS NULL")?;
    let rows = q.query_map([], |r| r.get::<_, String>(0))?;
    let mut out: Vec<Value> = vec![];
    for s in rows {
        if let Ok(v) = serde_json::from_str::<Value>(&s?) {
            out.push(v);
        }
    }
    out.sort_by(|a, b| {
        let k = |v: &Value| {
            (
                v.get("sort").and_then(|x| x.as_f64()).unwrap_or(f64::MAX),
                v.get("createdAt").and_then(|x| x.as_f64()).unwrap_or(0.0),
            )
        };
        k(a).partial_cmp(&k(b)).unwrap_or(std::cmp::Ordering::Equal)
    });
    Ok(out)
}

/// 把条目里的设备名 old 改成 new（不改 updatedAt，免得所有条目都显示“刚刚”）；返回改了几条
fn rename_in_items(tx: &Connection, old: &str, new: &str) -> Result<usize> {
    let ids: Vec<String> = {
        let mut q = tx.prepare("SELECT id FROM items WHERE device = ?1")?;
        let rows = q.query_map([old], |r| r.get::<_, String>(0))?;
        rows.collect::<std::result::Result<Vec<_>, _>>()?
    };
    for id in &ids {
        if let Some(row) = read_row(tx, id)? {
            let mut d = row.data;
            d["device"] = json!(new);
            write_row(tx, &d, row.deleted_at)?;
        }
    }
    Ok(ids.len())
}
