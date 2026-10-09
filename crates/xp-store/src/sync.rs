//! 多台电脑之间合并：通过移动硬盘上的一键备份交接。
//!
//! - 每个数据文件夹有一个标识（meta `replica_id`）和名字（这台电脑在设备表里的名字），
//!   条目的 `origin` 列记下最后一次是在哪个数据文件夹改的，合并时按来源分组显示
//! - 同步点：每次一键备份或合并后，把那份快照存成本机的 `sync/base.db`，meta `sync_base` 记下它是哪份
//! - 合并：本机 / 移动硬盘上的最新备份 / 同步点 三方对比。只有一边改了就用改了的那边；
//!   两边都改了算冲突，由人选。没有同步点（第一次合并）时，两边不一样的都算冲突，默认用较新的
//! - 附件、分类、设备、导入的聊天只增不减，直接合到一起

use crate::backup::{copy_atomic, host_name, prune, read_manifest, sync_assets};
use crate::{invalid, log, schema, write_row, Result, Store, StoreError};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use xp_core::{new_id, now_ms, str_of, updated_at};

pub(crate) const SYNC_DIR: &str = "sync";
const BASE_DB: &str = "base.db";
const INCOMING_DB: &str = "incoming.db";
const ACTOR_MERGE: &str = "merge";
/// 合并前的本机备份保留份数
const KEEP_PREMERGE: usize = 6;

pub(crate) fn meta_get(conn: &Connection, key: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0))
        .optional()?)
}

pub(crate) fn meta_set(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

fn meta_json(conn: &Connection, key: &str) -> Result<Value> {
    Ok(meta_get(conn, key)?
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null))
}

/// 认识的数据文件夹：{标识: 名字}
fn add_replica_names(conn: &Connection, names: &Map<String, Value>) -> Result<()> {
    let mut all = meta_json(conn, "replicas")?
        .as_object()
        .cloned()
        .unwrap_or_default();
    for (k, v) in names {
        if !k.is_empty() && v.as_str().is_some_and(|s| !s.is_empty()) {
            all.insert(k.clone(), v.clone());
        }
    }
    meta_set(conn, "replicas", &Value::Object(all).to_string())
}

// ---------------------------------------------------------------- 三方对比

struct MRow {
    data: Value,
    deleted: Option<f64>,
    origin: String,
}

impl MRow {
    fn alive(&self) -> bool {
        self.deleted.is_none()
    }
    fn changed_at(&self) -> f64 {
        updated_at(&self.data).max(self.deleted.unwrap_or(0.0))
    }
}

fn same(a: Option<&MRow>, b: Option<&MRow>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => a.data == b.data && a.alive() == b.alive(),
        _ => false,
    }
}

fn load_items(conn: &Connection) -> Result<HashMap<String, MRow>> {
    let mut q = conn.prepare("SELECT id, data, deleted_at, origin FROM items")?;
    let rows = q.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Option<f64>>(2)?,
            r.get::<_, String>(3)?,
        ))
    })?;
    let mut out = HashMap::new();
    for row in rows {
        let (id, data, deleted, origin) = row?;
        let data: Value = serde_json::from_str(&data).unwrap_or(Value::Null);
        if data.is_object() {
            out.insert(
                id,
                MRow {
                    data,
                    deleted,
                    origin,
                },
            );
        }
    }
    Ok(out)
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Add,
    Update,
    Delete,
    Conflict,
}

impl Kind {
    fn name(self) -> &'static str {
        match self {
            Kind::Add => "add",
            Kind::Update => "update",
            Kind::Delete => "delete",
            Kind::Conflict => "conflict",
        }
    }
}

struct Change<'a> {
    id: &'a str,
    kind: Kind,
    remote: &'a MRow,
    local: Option<&'a MRow>,
    /// 默认用移动硬盘上的（冲突时取较新的那边）
    take_remote: bool,
}

/// 移动硬盘上那份相对本机的改动。只看移动硬盘上有的条目：本机独有的条目合并时原样保留
fn diff<'a>(
    local: &'a HashMap<String, MRow>,
    remote: &'a HashMap<String, MRow>,
    base: Option<&'a HashMap<String, MRow>>,
) -> Vec<Change<'a>> {
    let mut out = vec![];
    for (id, r) in remote {
        let l = local.get(id);
        if same(l, Some(r)) {
            continue;
        }
        let l_alive = l.is_some_and(|l| l.alive());
        if !l_alive && !r.alive() {
            continue; // 两边都没有这条（或都删了），看不出区别
        }
        let conflict = match base {
            None => l.is_some(),
            Some(b) => {
                let bb = b.get(id);
                if same(Some(r), bb) {
                    continue; // 移动硬盘那边没改，是本机改的
                }
                !same(l, bb)
            }
        };
        let kind = if conflict {
            Kind::Conflict
        } else if !l_alive {
            Kind::Add
        } else if r.alive() {
            Kind::Update
        } else {
            Kind::Delete
        };
        let take_remote = !conflict || r.changed_at() >= l.map_or(0.0, |l| l.changed_at());
        out.push(Change {
            id,
            kind,
            remote: r,
            local: l,
            take_remote,
        });
    }
    out.sort_by(|a, b| b.remote.changed_at().total_cmp(&a.remote.changed_at()));
    out
}

// ---------------------------------------------------------------- Store

/// 打开一份数据库副本（移动硬盘上的快照、同步点），升级到当前结构
fn open_copy(p: &Path) -> Result<Connection> {
    let c = Connection::open(p)?;
    schema::migrate(&c)?;
    Ok(c)
}

impl Store {
    /// 打开时确认这个数据文件夹的标识和名字。
    /// 数据文件夹被整个复制到另一台电脑时换一个新标识，免得两边分不清谁改的
    pub(crate) fn init_replica(&self) -> Result<()> {
        let conn = self.lock();
        let host = host_name();
        if !host.is_empty() {
            match meta_get(&conn, "replica_host")? {
                Some(h) if h != host => {
                    conn.execute(
                        "UPDATE meta SET value = lower(hex(randomblob(6))) WHERE key = 'replica_id'",
                        [],
                    )?;
                    conn.execute(
                        "DELETE FROM meta WHERE key IN ('replica_name', 'sync_base')",
                        [],
                    )?;
                }
                _ => {}
            }
            meta_set(&conn, "replica_host", &host)?;
        }
        if meta_get(&conn, "replica_name")?.is_none() {
            let name = if host.is_empty() {
                "这台电脑"
            } else {
                &host
            };
            meta_set(&conn, "replica_name", name)?;
        }
        let id = meta_get(&conn, "replica_id")?.unwrap_or_default();
        let name = meta_get(&conn, "replica_name")?.unwrap_or_default();
        add_replica_names(&conn, &Map::from_iter([(id, json!(name))]))
    }

    /// 这个数据文件夹的标识和名字
    pub fn replica(&self) -> Result<(String, String)> {
        let conn = self.lock();
        Ok((
            meta_get(&conn, "replica_id")?.unwrap_or_default(),
            meta_get(&conn, "replica_name")?.unwrap_or_default(),
        ))
    }

    /// 名字用这台电脑在设备表里的名字（桌面版打开时设置）
    pub fn set_replica_name(&self, name: &str) -> Result<()> {
        let name = name.trim();
        if name.is_empty() {
            return Ok(());
        }
        let conn = self.lock();
        meta_set(&conn, "replica_name", name)?;
        let id = meta_get(&conn, "replica_id")?.unwrap_or_default();
        add_replica_names(&conn, &Map::from_iter([(id, json!(name))]))
    }

    /// 上次和移动硬盘对齐时的那份备份（没有 = 还没备份或合并过）
    pub(crate) fn sync_base(&self) -> Result<Value> {
        meta_json(&self.lock(), "sync_base")
    }

    /// 刚做完的一键备份就是新的同步点
    pub(crate) fn set_sync_base(&self, snapshot: &Path, manifest: &Value) -> Result<()> {
        let fail = |e: std::io::Error| StoreError::Unavailable(format!("记录同步点失败：{e}"));
        let sdir = self.dir.join(SYNC_DIR);
        fs::create_dir_all(&sdir).map_err(fail)?;
        if snapshot != sdir.join(BASE_DB) {
            copy_atomic(snapshot, &sdir.join(BASE_DB)).map_err(fail)?;
        }
        meta_set(&self.lock(), "sync_base", &manifest.to_string())
    }

    /// 移动硬盘上最新的一键备份：复制到本机 sync/incoming.db 再打开（不直接读移动硬盘上的文件）
    fn fetch_latest(&self) -> Result<(Value, PathBuf, PathBuf)> {
        let cold = self.cold_root_ready()?;
        let manifest = read_manifest(&cold)
            .ok_or_else(|| invalid("移动硬盘上还没有一键备份。先在另一台电脑上点「立即备份」"))?;
        let file = str_of(&manifest, "file").to_string();
        if !file.starts_with("snapshots/") || file.contains("..") {
            return Err(invalid("备份记录 latest.json 有误"));
        }
        let src = cold.join(&file);
        if !src.is_file() {
            return Err(StoreError::Unavailable(format!(
                "找不到备份文件 {}",
                src.display()
            )));
        }
        let sdir = self.dir.join(SYNC_DIR);
        fs::create_dir_all(&sdir)
            .map_err(|e| StoreError::Unavailable(format!("无法创建 {}：{e}", sdir.display())))?;
        let local = sdir.join(INCOMING_DB);
        for ext in ["", "-wal", "-shm"] {
            let _ = fs::remove_file(sdir.join(format!("{INCOMING_DB}{ext}")));
        }
        copy_atomic(&src, &local)
            .map_err(|e| StoreError::Unavailable(format!("读取移动硬盘上的备份失败：{e}")))?;
        Ok((manifest, local, cold))
    }

    fn base_rows(&self) -> Result<Option<HashMap<String, MRow>>> {
        let p = self.dir.join(SYNC_DIR).join(BASE_DB);
        if self.sync_base()?.is_null() || !p.is_file() {
            return Ok(None);
        }
        Ok(Some(load_items(&open_copy(&p)?)?))
    }

    /// 合并预览：移动硬盘上的最新备份和本机比，有哪些改动
    pub fn merge_preview(&self) -> Result<Value> {
        let _g = self.cold_busy.lock().unwrap_or_else(|e| e.into_inner());
        let (manifest, incoming, cold) = self.fetch_latest()?;
        let (remote, remote_names) = {
            let rc = open_copy(&incoming)?;
            (load_items(&rc)?, meta_json(&rc, "replicas")?)
        };
        let base = self.base_rows()?;
        let (local, names, me) = {
            let conn = self.lock();
            (
                load_items(&conn)?,
                meta_json(&conn, "replicas")?,
                meta_get(&conn, "replica_id")?.unwrap_or_default(),
            )
        };
        let name_of = |id: &str| -> String {
            if id.is_empty() {
                return String::new();
            }
            [&remote_names, &names]
                .iter()
                .find_map(|m| m.get(id).and_then(|v| v.as_str()))
                .unwrap_or("")
                .to_string()
        };
        let changes = diff(&local, &remote, base.as_ref());
        let mut counts: HashMap<&str, usize> = HashMap::new();
        let list: Vec<Value> = changes
            .iter()
            .map(|c| {
                *counts.entry(c.kind.name()).or_default() += 1;
                let r = &c.remote.data;
                json!({
                    "id": c.id,
                    "kind": c.kind.name(),
                    "type": str_of(r, "type"),
                    "title": str_of(r, "title"),
                    "localTitle": c.local.map(|l| str_of(&l.data, "title")),
                    "remoteDeleted": !c.remote.alive(),
                    "localDeleted": c.local.is_some_and(|l| !l.alive()),
                    "remoteAt": c.remote.changed_at(),
                    "localAt": c.local.map(|l| l.changed_at()),
                    "origin": c.remote.origin,
                    "originName": name_of(&c.remote.origin),
                    "originIsMe": !me.is_empty() && c.remote.origin == me,
                    "choice": if c.take_remote { "remote" } else { "local" },
                })
            })
            .collect();
        let (missing, missing_bytes) =
            missing_assets(&cold.join("assets"), &self.dir.join("assets"));
        Ok(json!({
            "latest": manifest,
            "base": self.sync_base()?,
            "first": base.is_none(),
            "changes": list,
            "counts": counts,
            "assets": { "missing": missing, "bytes": missing_bytes },
        }))
    }

    /// 执行合并。choices：条目 id → "remote"（用移动硬盘上的）/ "both"（冲突时两份都留）/ 其他（保留本机的）。
    /// file 是预览时看到的那份备份，期间移动硬盘上的备份变了就不合并。
    pub fn merge_apply(&self, file: &str, choices: &HashMap<String, String>) -> Result<Value> {
        let _g = self.cold_busy.lock().unwrap_or_else(|e| e.into_inner());
        let (manifest, incoming, cold) = self.fetch_latest()?;
        if str_of(&manifest, "file") != file {
            return Err(invalid(
                "移动硬盘上的备份刚刚变了（可能别的电脑又备份过），请重新打开合并",
            ));
        }
        // 附件先补齐，条目引用到的文件才都在
        let a = sync_assets(&cold.join("assets"), &self.dir.join("assets"))
            .map_err(|e| StoreError::Unavailable(format!("复制附件失败：{e}")))?;
        self.register_assets();
        // 合并前留一份本机备份，合错了能找回来
        {
            let bdir = self.dir.join("backups");
            let _ = fs::create_dir_all(&bdir);
            let target = bdir.join(format!("premerge-{}.db", xp_core::stamp_local()));
            self.lock()
                .backup(rusqlite::DatabaseName::Main, &target, None)
                .map_err(|e| StoreError::Unavailable(format!("合并前备份失败，没有合并：{e}")))?;
            prune(&bdir, "premerge-", KEEP_PREMERGE);
        }
        let rconn = open_copy(&incoming)?;
        let remote = load_items(&rconn)?;
        let base = self.base_rows()?;
        let remote_names = meta_json(&rconn, "replicas")?;
        let now = now_ms();
        let (summary, _) = self.write(|tx| {
            let local = load_items(tx)?;
            let mut n: HashMap<&str, usize> = HashMap::new();
            let mut kept = 0usize;
            for c in diff(&local, &remote, base.as_ref()) {
                let choice = choices.get(c.id).map(String::as_str).unwrap_or("");
                let both = choice == "both" && c.kind == Kind::Conflict && c.remote.alive();
                if choice != "remote" && !both {
                    kept += 1;
                    continue;
                }
                let r = c.remote;
                if both {
                    let from = remote_names
                        .get(&r.origin)
                        .and_then(|v| v.as_str())
                        .unwrap_or("另一台电脑");
                    let mut copy = r.data.clone();
                    copy["id"] = json!(new_id());
                    copy["title"] = json!(format!("{}（{from}的版本）", str_of(&r.data, "title")));
                    copy["updatedAt"] = json!(now);
                    // 复制出来的这条是在本机新建的，来源算本机
                    put_row(tx, &copy, None, None, "create", None)?;
                    *n.entry("both").or_default() += 1;
                    continue;
                }
                let action = match c.kind {
                    Kind::Add => "create",
                    Kind::Delete => "delete",
                    _ => "update",
                };
                put_row(
                    tx,
                    &r.data,
                    r.deleted,
                    Some(&r.origin),
                    action,
                    c.local.map(|l| &l.data),
                )?;
                *n.entry(c.kind.name()).or_default() += 1;
            }
            let other = merge_other(tx, &rconn)?;
            if let Some(names) = remote_names.as_object() {
                add_replica_names(tx, names)?;
            }
            let total: usize = n.values().sum();
            log(
                tx,
                ACTOR_MERGE,
                "merge",
                "",
                None,
                None,
                Some(&format!(
                    "从移动硬盘合并（{}）：改了 {total} 条，保留本机 {kept} 条，补了 {} 个附件",
                    str_of(&manifest, "replicaName"),
                    a.copied_files
                )),
            )?;
            Ok(json!({ "applied": n, "kept": kept, "other": other }))
        })?;
        drop(rconn);
        // 这份备份就是新的同步点
        let sdir = self.dir.join(SYNC_DIR);
        fs::rename(&incoming, sdir.join(BASE_DB))
            .map_err(|e| StoreError::Unavailable(format!("记录同步点失败：{e}")))?;
        for ext in ["-wal", "-shm"] {
            let _ = fs::remove_file(sdir.join(format!("{INCOMING_DB}{ext}")));
        }
        meta_set(&self.lock(), "sync_base", &manifest.to_string())?;
        Ok(json!({
            "latest": manifest,
            "applied": summary["applied"],
            "kept": summary["kept"],
            "other": summary["other"],
            "copiedFiles": a.copied_files,
            "copiedBytes": a.copied_bytes,
        }))
    }
}

/// 写入一条来自移动硬盘的条目，origin 有值时保留它原来的来源（None = 算本机）；
/// 操作记录存前后内容，合错了能查
fn put_row(
    tx: &Connection,
    data: &Value,
    deleted: Option<f64>,
    origin: Option<&str>,
    action: &str,
    before: Option<&Value>,
) -> Result<()> {
    write_row(tx, data, deleted)?;
    let id = str_of(data, "id");
    if let Some(origin) = origin {
        tx.execute(
            "UPDATE items SET origin = ?1 WHERE id = ?2",
            params![origin, id],
        )?;
    }
    let after = deleted.is_none().then_some(data);
    log(tx, ACTOR_MERGE, action, id, before, after, None)
}

/// 移动硬盘上有、本机没有的附件
fn missing_assets(src: &Path, dst: &Path) -> (u64, u64) {
    let (mut n, mut bytes) = (0, 0);
    let Ok(rd) = fs::read_dir(src) else {
        return (0, 0);
    };
    for e in rd.flatten() {
        let Ok(m) = e.metadata() else { continue };
        let name = e.file_name();
        if m.is_file()
            && !name.to_string_lossy().starts_with('.')
            && dst.join(&name).metadata().map(|x| x.len()).ok() != Some(m.len())
        {
            n += 1;
            bytes += m.len();
        }
    }
    (n, bytes)
}

/// 条目以外的数据：只增不减
fn merge_other(tx: &Connection, r: &Connection) -> Result<Value> {
    // 分类（手工建的空分类）
    let mut cats = 0;
    {
        let mut q = r.prepare("SELECT path, created_at FROM categories")?;
        let rows = q.query_map([], |x| Ok((x.get::<_, String>(0)?, x.get::<_, f64>(1)?)))?;
        for row in rows {
            let (p, at) = row?;
            cats += tx.execute(
                "INSERT OR IGNORE INTO categories (path, created_at) VALUES (?1, ?2)",
                params![p, at],
            )?;
        }
    }
    // 本机没设过的设置（任务模板、收件箱里哪些是我）
    for key in ["templates", "inbox.me"] {
        if meta_get(tx, key)?.is_none() {
            if let Some(v) = meta_get(r, key)? {
                meta_set(tx, key, &v)?;
            }
        }
    }
    // 设备：本机没有的（名字也没被占用）才加
    let mut devices = 0;
    {
        let mut q = r.prepare(
            "SELECT id, name, last_seen, created_at, updated_at, data FROM devices WHERE deleted_at IS NULL",
        )?;
        let rows = q.query_map([], |x| {
            Ok((
                x.get::<_, String>(0)?,
                x.get::<_, String>(1)?,
                x.get::<_, Option<f64>>(2)?,
                x.get::<_, f64>(3)?,
                x.get::<_, f64>(4)?,
                x.get::<_, String>(5)?,
            ))
        })?;
        for row in rows {
            let (id, name, seen, created, updated, data) = row?;
            let taken: bool = tx
                .query_row(
                    "SELECT 1 FROM devices WHERE id = ?1 OR (name = ?2 AND deleted_at IS NULL)",
                    params![id, name],
                    |_| Ok(()),
                )
                .optional()?
                .is_some();
            if !taken {
                devices += tx.execute(
                    "INSERT INTO devices (id, name, last_seen, created_at, updated_at, deleted_at, data) VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6)",
                    params![id, name, seen, created, updated, data],
                )?;
            }
        }
    }
    let (chats, messages) = merge_chats(tx, r)?;
    Ok(json!({ "categories": cats, "devices": devices, "chats": chats, "messages": messages }))
}

/// 导入的聊天：同一个聊天（同 id，或同来源同名字）合到一起，消息按指纹去重；
/// 移动硬盘那边删掉的消息，本机也删
fn merge_chats(tx: &Connection, r: &Connection) -> Result<(usize, usize)> {
    let mut map: HashMap<String, String> = HashMap::new();
    let mut chats = 0;
    {
        let mut q = r.prepare(
            "SELECT id, source, name, created_at, updated_at, deleted_at, data FROM chats",
        )?;
        let rows = q.query_map([], |x| {
            Ok((
                x.get::<_, String>(0)?,
                x.get::<_, String>(1)?,
                x.get::<_, String>(2)?,
                x.get::<_, f64>(3)?,
                x.get::<_, f64>(4)?,
                x.get::<_, Option<f64>>(5)?,
                x.get::<_, String>(6)?,
            ))
        })?;
        for row in rows {
            let (id, source, name, created, updated, deleted, data) = row?;
            let by_id: Option<f64> = tx
                .query_row("SELECT updated_at FROM chats WHERE id = ?1", [&id], |x| {
                    x.get(0)
                })
                .optional()?;
            if let Some(local_updated) = by_id {
                if updated > local_updated {
                    // 较新的（比如「已处理到哪」）；改名撞上本机别的聊天就算了
                    let _ = tx.execute(
                        "UPDATE chats SET source = ?2, name = ?3, updated_at = ?4, deleted_at = ?5, data = ?6 WHERE id = ?1",
                        params![id, source, name, updated, deleted, data],
                    );
                }
                map.insert(id.clone(), id);
                continue;
            }
            let by_name: Option<String> = tx
                .query_row(
                    "SELECT id FROM chats WHERE source = ?1 AND name = ?2 AND deleted_at IS NULL",
                    params![source, name],
                    |x| x.get(0),
                )
                .optional()?;
            if let Some(local_id) = by_name {
                map.insert(id, local_id);
            } else if deleted.is_none() {
                chats += tx.execute(
                    "INSERT INTO chats (id, source, name, created_at, updated_at, deleted_at, data) VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6)",
                    params![id, source, name, created, updated, data],
                )?;
                map.insert(id.clone(), id);
            }
        }
    }
    {
        let mut q = r.prepare("SELECT id, chat_id, imported_at, data FROM bundles")?;
        let rows = q.query_map([], |x| {
            Ok((
                x.get::<_, String>(0)?,
                x.get::<_, String>(1)?,
                x.get::<_, f64>(2)?,
                x.get::<_, String>(3)?,
            ))
        })?;
        for row in rows {
            let (id, chat, at, data) = row?;
            let Some(chat) = map.get(&chat) else { continue };
            let mut v: Value = serde_json::from_str(&data).unwrap_or(json!({}));
            v["chatId"] = json!(chat);
            tx.execute(
                "INSERT OR IGNORE INTO bundles (id, chat_id, imported_at, data) VALUES (?1, ?2, ?3, ?4)",
                params![id, chat, at, v.to_string()],
            )?;
        }
    }
    let mut messages = 0;
    {
        let mut q = r.prepare(
            "SELECT id, chat_id, bundle_id, bundle_at, seq, time, sender, text, attachments, fp, deleted_at FROM messages",
        )?;
        let rows = q.query_map([], |x| {
            Ok((
                [
                    x.get::<_, String>(0)?,
                    x.get::<_, String>(1)?,
                    x.get::<_, String>(2)?,
                ],
                x.get::<_, f64>(3)?,
                x.get::<_, i64>(4)?,
                [
                    x.get::<_, String>(5)?,
                    x.get::<_, String>(6)?,
                    x.get::<_, String>(7)?,
                    x.get::<_, String>(8)?,
                    x.get::<_, String>(9)?,
                ],
                x.get::<_, Option<f64>>(10)?,
            ))
        })?;
        for row in rows {
            let ([id, chat, bundle], bundle_at, seq, [time, sender, text, atts, fp], deleted) =
                row?;
            let Some(chat) = map.get(&chat) else { continue };
            let added = tx.execute(
                "INSERT OR IGNORE INTO messages (id, chat_id, bundle_id, bundle_at, seq, time, sender, text, attachments, fp, deleted_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![id, chat, bundle, bundle_at, seq, time, sender, text, atts, fp, deleted],
            )?;
            if added == 1 {
                if deleted.is_none() {
                    tx.execute(
                        "INSERT INTO messages_fts (id, sender, text) VALUES (?1, ?2, ?3)",
                        params![id, sender, text],
                    )?;
                    messages += 1;
                }
            } else if let Some(at) = deleted {
                let local: Option<String> = tx
                    .query_row(
                        "SELECT id FROM messages WHERE chat_id = ?1 AND fp = ?2 AND deleted_at IS NULL",
                        params![chat, fp],
                        |x| x.get(0),
                    )
                    .optional()?;
                if let Some(lid) = local {
                    tx.execute(
                        "UPDATE messages SET deleted_at = ?2 WHERE id = ?1",
                        params![lid, at],
                    )?;
                    tx.execute("DELETE FROM messages_fts WHERE id = ?1", [lid])?;
                }
            }
        }
    }
    Ok((chats, messages))
}
