//! xpanel 存储层：一个数据文件夹 = 一个 SQLite 数据库 + assets/ 附件 + backups/ 备份。
//!
//! - 条目整条 JSON 存在 `data` 列（和 v1 一样是自由 JSON），常用字段另外拆成列方便查询
//! - 删除是软删除（`deleted_at`），同步和撤销都靠它
//! - 每次写入 `rev` 加 1，界面和其他设备据此判断要不要刷新
//! - 每天第一次写入前备份一次；设置了冷备份位置时再复制一份过去
//! - 第一次打开旧数据文件夹时自动导入 `workbench.json`，原文件改名保留

mod assets;
mod backup;
mod categories;
mod devices;
mod inbox;
mod keys;
mod schema;
mod sync;

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tokio::sync::broadcast;
use xp_core::{
    apply_patch, id_of, now_ms, plan_reprioritize, sort_items, stamp_done, str_of, updated_at,
    Filter, Op, PriorityChange, PriorityDiff,
};

pub use assets::{mime_of, safe_asset_name};
pub use inbox::{MessageQuery, SOURCE_WECHAT};
pub use sync::{SideInfo, SyncPlan, SyncReport};

pub const DB_FILE: &str = "xpanel.db";
/// 界面（旧版 index.html 和桌面版）写入时用的操作者名
pub const ACTOR_UI: &str = "ui";
pub const DEFAULT_LIMIT: usize = 200;
pub const MAX_LIMIT: usize = 5000;

// ---------------------------------------------------------------- 错误

#[derive(Debug, Clone, PartialEq)]
pub enum StoreError {
    /// 请求本身有问题，重试没用（对应 HTTP 400）
    Invalid(String),
    /// 找不到（404）
    NotFound(String),
    /// 暂时存不了、读不了，比如磁盘问题（503，客户端应稍后重试）
    Unavailable(String),
    /// 别处刚改过，这次修改基于旧内容（409，界面让用户选留哪份）
    Conflict(String),
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StoreError::Invalid(m)
            | StoreError::NotFound(m)
            | StoreError::Unavailable(m)
            | StoreError::Conflict(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for StoreError {}

impl From<rusqlite::Error> for StoreError {
    fn from(e: rusqlite::Error) -> Self {
        StoreError::Unavailable(format!("数据库出错：{e}"))
    }
}

pub type Result<T> = std::result::Result<T, StoreError>;

fn invalid(m: impl Into<String>) -> StoreError {
    StoreError::Invalid(m.into())
}

// ---------------------------------------------------------------- Store

pub struct Store {
    dir: PathBuf,
    conn: Mutex<Connection>,
    cold_dir: Mutex<Option<PathBuf>>,
    backed_up_day: Mutex<String>,
    events: broadcast::Sender<u64>,
}

/// 旧版 workbench.json 的读取（数组，或 {version, items}）
fn read_v1_items(p: &Path) -> Result<Vec<Value>> {
    let raw = fs::read_to_string(p)
        .map_err(|e| StoreError::Unavailable(format!("读取 {} 失败：{e}", p.display())))?;
    let s = raw.trim_start_matches('\u{feff}');
    if s.trim().is_empty() {
        return Ok(vec![]);
    }
    let v: Value =
        serde_json::from_str(s).map_err(|e| invalid(format!("{} 格式有误：{e}", p.display())))?;
    Ok(match v {
        Value::Array(a) => a,
        Value::Object(mut o) => match o.remove("items") {
            Some(Value::Array(a)) => a,
            _ => vec![],
        },
        _ => vec![],
    })
}

impl Store {
    /// 打开（或新建）数据文件夹
    pub fn open(dir: impl AsRef<Path>) -> Result<Store> {
        let dir = dir.as_ref().to_path_buf();
        if dir.as_os_str().is_empty() {
            return Err(invalid("还没有设置数据文件夹"));
        }
        if !dir.is_dir() {
            fs::create_dir_all(&dir).map_err(|e| {
                StoreError::Unavailable(format!("无法访问数据文件夹 {}：{e}", dir.display()))
            })?;
        }
        let conn = Connection::open(dir.join(DB_FILE)).map_err(|e| {
            StoreError::Unavailable(format!(
                "无法打开数据库 {}：{e}",
                dir.join(DB_FILE).display()
            ))
        })?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        // 数据库要升级时，先单独备份一份（不参与 60 份的轮换）
        let v: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if v > 0 && v < schema::SCHEMA_VERSION {
            let b = dir.join("backups");
            let _ = fs::create_dir_all(&b);
            let target = b.join(format!("premigrate-v{v}-{}.db", xp_core::today_local()));
            if !target.exists() {
                conn.backup(rusqlite::DatabaseName::Main, &target, None)
                    .map_err(|e| {
                        StoreError::Unavailable(format!("升级前备份失败，没有升级：{e}"))
                    })?;
            }
        }
        schema::migrate(&conn)?;
        let (events, _) = broadcast::channel(64);
        let st = Store {
            dir,
            conn: Mutex::new(conn),
            cold_dir: Mutex::new(None),
            backed_up_day: Mutex::new(String::new()),
            events,
        };
        st.import_v1()?;
        st.seed_devices()?;
        st.register_assets();
        st.daily_backup();
        Ok(st)
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// 冷备份位置（比如 8TB 盘）；None 表示不做冷备份
    /// 设置后马上补一次当天的冷备份（打开时的备份早于这里的设置）
    pub fn set_cold_backup_dir(&self, dir: Option<PathBuf>) {
        let dir = dir.filter(|d| !d.as_os_str().is_empty());
        let changed = {
            let mut cur = self.cold_dir.lock().unwrap_or_else(|e| e.into_inner());
            let changed = *cur != dir;
            *cur = dir.clone();
            changed
        };
        if changed && dir.is_some() {
            if let Err(e) = self.backup_now(&xp_core::today_local()) {
                eprintln!("备份失败：{e}");
            }
        }
    }

    /// 数据变化通知：每次写入后发出新的 rev
    pub fn subscribe(&self) -> broadcast::Receiver<u64> {
        self.events.subscribe()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 在一个事务里写入；成功后 rev +1 并通知订阅者
    fn write<T>(&self, f: impl FnOnce(&Transaction) -> Result<T>) -> Result<(T, u64)> {
        self.daily_backup();
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        let out = f(&tx)?;
        tx.execute(
            "UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'rev'",
            [],
        )?;
        let rev: u64 = tx.query_row(
            "SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'rev'",
            [],
            |r| r.get(0),
        )?;
        tx.commit()?;
        drop(conn);
        let _ = self.events.send(rev);
        Ok((out, rev))
    }

    pub fn rev(&self) -> Result<u64> {
        Ok(self.lock().query_row(
            "SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'rev'",
            [],
            |r| r.get(0),
        )?)
    }

    /// 所有未删除的条目，按创建顺序（和 v1 的数组顺序一致）
    pub fn all_items(&self) -> Result<Vec<Value>> {
        let conn = self.lock();
        let mut q =
            conn.prepare("SELECT data FROM items WHERE deleted_at IS NULL ORDER BY rowid")?;
        let rows = q.query_map([], |r| r.get::<_, String>(0))?;
        let mut out = vec![];
        for s in rows {
            out.push(serde_json::from_str(&s?).unwrap_or(Value::Null));
        }
        Ok(out.into_iter().filter(|v| v.is_object()).collect())
    }

    /// v1 接口的数据格式：{ rev, items, devices }（devices 是新加的，旧界面会忽略）
    pub fn legacy_state(&self) -> Result<Value> {
        let items = self.all_items()?;
        let devices = self.list_devices()?;
        let categories = self.category_paths()?;
        Ok(
            json!({ "rev": legacy_rev(self.rev()?), "items": items, "devices": devices, "categories": categories }),
        )
    }

    // ------------------------------------------------------------ v1 操作

    /// 执行一个 v1 操作（旧界面、连接模式在用）
    pub fn apply_op(&self, op: Op, actor: &str) -> Result<u64> {
        xp_core::validate_op(&op).map_err(invalid)?;
        let now = now_ms();
        let (_, rev) = self.write(|tx| {
            match op {
                Op::Upsert { item } => upsert(tx, item, actor, now)?,
                Op::Patch {
                    id,
                    set,
                    unset,
                    expect,
                } => patch(tx, &id, set, unset, expect, actor, now)?,
                Op::Delete { id } => {
                    soft_delete(tx, &id, actor, now)?;
                }
                Op::Import { items } => {
                    for it in items {
                        let Some(id) = id_of(&it) else { continue };
                        let newer = match read_row(tx, &id)? {
                            None => true,
                            Some(row) => updated_at(&it) >= row.last_changed(),
                        };
                        if newer && it.is_object() {
                            upsert(tx, it, actor, now)?;
                        }
                    }
                }
            }
            Ok(())
        })?;
        Ok(rev)
    }

    // ------------------------------------------------------------ 对外 API 用

    pub fn get(&self, id: &str) -> Result<Value> {
        let conn = self.lock();
        match read_row(&conn, id)? {
            Some(r) if r.deleted_at.is_none() => Ok(r.data),
            _ => Err(StoreError::NotFound(format!("找不到条目 {id}"))),
        }
    }

    /// 按条件查询，返回（当前页, 符合条件的总数）。排序：置顶 → 优先级 → 手动排序 → 最近更新
    pub fn list(&self, f: &Filter) -> Result<(Vec<Value>, usize)> {
        let items = self.query(f)?;
        let total = items.len();
        let offset = f.offset.unwrap_or(0);
        let limit = f.limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT);
        Ok((items.into_iter().skip(offset).take(limit).collect(), total))
    }

    /// 按条件查询全部结果（不分页），导出和统计用
    pub fn query(&self, f: &Filter) -> Result<Vec<Value>> {
        f.status().map_err(invalid)?;
        let mut items = self.search(f.q.as_deref().unwrap_or(""))?;
        items.retain(|v| f.matches(v));
        sort_items(&mut items);
        Ok(items)
    }

    /// 关键词搜索：3 个字及以上走全文索引（trigram，中文也能搜），更短的用 LIKE
    fn search(&self, q: &str) -> Result<Vec<Value>> {
        let terms: Vec<&str> = q.split_whitespace().collect();
        let mut sql = String::from("SELECT data FROM items WHERE deleted_at IS NULL");
        let mut args: Vec<String> = vec![];
        let fts: Vec<String> = terms
            .iter()
            .filter(|t| t.chars().count() >= 3)
            .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
            .collect();
        if !fts.is_empty() {
            sql += " AND id IN (SELECT id FROM items_fts WHERE items_fts MATCH ?)";
            args.push(fts.join(" AND "));
        }
        for t in terms.iter().filter(|t| t.chars().count() < 3) {
            sql += " AND (title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')";
            let like = format!(
                "%{}%",
                t.replace('\\', "\\\\")
                    .replace('%', "\\%")
                    .replace('_', "\\_")
            );
            args.push(like.clone());
            args.push(like);
        }
        sql += " ORDER BY rowid";
        let conn = self.lock();
        let mut q = conn.prepare(&sql)?;
        let rows = q.query_map(rusqlite::params_from_iter(args.iter()), |r| {
            r.get::<_, String>(0)
        })?;
        let mut out = vec![];
        for s in rows {
            if let Ok(v) = serde_json::from_str::<Value>(&s?) {
                out.push(v);
            }
        }
        Ok(out)
    }

    /// 新建条目（已由 xp_core::NewItem 生成）。同一个 id 再次提交只更新内容，
    /// 保留原来的创建时间和完成状态，所以 AI 重试不会产生重复条目。
    pub fn create(&self, items: Vec<Value>, actor: &str) -> Result<Vec<Value>> {
        let now = now_ms();
        let (out, _) = self.write(|tx| {
            let mut out = vec![];
            for mut it in items {
                let id = id_of(&it).ok_or_else(|| invalid("条目缺少 id"))?;
                if let Some(row) = read_row(tx, &id)?.filter(|r| r.deleted_at.is_none()) {
                    let o = it
                        .as_object_mut()
                        .ok_or_else(|| invalid("条目必须是 JSON 对象"))?;
                    for k in ["createdAt", "createdBy", "done", "doneAt", "pinned"] {
                        match row.data.get(k) {
                            Some(v) => {
                                o.insert(k.into(), v.clone());
                            }
                            None => {
                                o.remove(k);
                            }
                        }
                    }
                }
                upsert(tx, it.clone(), actor, now)?;
                out.push(read_row(tx, &id)?.map(|r| r.data).unwrap_or(it));
            }
            Ok(out)
        })?;
        Ok(out)
    }

    /// 按字段修改
    pub fn update(&self, id: &str, patch: &Map<String, Value>, actor: &str) -> Result<Value> {
        let now = now_ms();
        let (v, _) = self.write(|tx| {
            let row = read_row(tx, id)?
                .filter(|r| r.deleted_at.is_none())
                .ok_or_else(|| StoreError::NotFound(format!("找不到条目 {id}")))?;
            let mut next = row.data.clone();
            apply_patch(&mut next, patch, now).map_err(invalid)?;
            upsert(tx, next.clone(), actor, now)?;
            Ok(read_row(tx, id)?.map(|r| r.data).unwrap_or(next))
        })?;
        Ok(v)
    }

    /// 往条目的某个数组字段（AI 进展、问答…）末尾追加一条，最多保留 cap 条（在一个事务里，不会互相覆盖）
    pub fn append_to(
        &self,
        id: &str,
        field: &str,
        entry: Value,
        cap: usize,
        actor: &str,
    ) -> Result<Value> {
        let now = now_ms();
        let (v, _) = self.write(|tx| {
            let row = read_row(tx, id)?
                .filter(|r| r.deleted_at.is_none())
                .ok_or_else(|| StoreError::NotFound(format!("找不到条目 {id}")))?;
            let mut next = row.data.clone();
            let mut list = next
                .get(field)
                .and_then(|x| x.as_array())
                .cloned()
                .unwrap_or_default();
            list.push(entry);
            if list.len() > cap {
                list.drain(..list.len() - cap);
            }
            next[field] = Value::Array(list);
            next["updatedAt"] = json!(now);
            upsert(tx, next.clone(), actor, now)?;
            Ok(next)
        })?;
        Ok(v)
    }

    /// 任务模板：存在 meta 里，没存过就用内置的
    pub fn templates(&self) -> Result<Vec<xp_core::templates::Template>> {
        let s: Option<String> = self
            .lock()
            .query_row("SELECT value FROM meta WHERE key = 'templates'", [], |r| {
                r.get(0)
            })
            .optional()?;
        Ok(s.and_then(|s| serde_json::from_str(&s).ok())
            .filter(|v: &Vec<xp_core::templates::Template>| !v.is_empty())
            .unwrap_or_else(xp_core::templates::builtin))
    }

    pub fn set_templates(
        &self,
        list: Vec<xp_core::templates::Template>,
    ) -> Result<Vec<xp_core::templates::Template>> {
        let mut seen = vec![];
        for t in &list {
            if t.id.trim().is_empty() || t.name.trim().is_empty() {
                return Err(invalid("每个模板都要有 id 和名字"));
            }
            if seen.contains(&t.id) {
                return Err(invalid(format!("模板 id {} 重复了", t.id)));
            }
            seen.push(t.id.clone());
        }
        // 清空就是恢复内置的
        let v = if list.is_empty() {
            None
        } else {
            Some(serde_json::to_string(&list).map_err(|e| invalid(e.to_string()))?)
        };
        self.write(|tx| {
            match &v {
                Some(v) => tx.execute(
                    "INSERT INTO meta (key, value) VALUES ('templates', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    [v],
                )?,
                None => tx.execute("DELETE FROM meta WHERE key = 'templates'", [])?,
            };
            Ok(())
        })?;
        self.templates()
    }

    pub fn delete(&self, id: &str, actor: &str) -> Result<()> {
        let now = now_ms();
        self.write(|tx| {
            if soft_delete(tx, id, actor, now)? {
                Ok(())
            } else {
                Err(StoreError::NotFound(format!("找不到条目 {id}")))
            }
        })?;
        Ok(())
    }

    /// 批量调整优先级 / 排序。dry_run 只返回对比，不修改；任一条不合法则整批不生效。
    pub fn reprioritize(
        &self,
        changes: &[PriorityChange],
        dry_run: bool,
        actor: &str,
    ) -> Result<Vec<PriorityDiff>> {
        if changes.is_empty() {
            return Err(invalid("changes 不能为空"));
        }
        let now = now_ms();
        let current = |conn: &Connection| -> Result<BTreeMap<String, Value>> {
            let mut m = BTreeMap::new();
            for c in changes {
                if let Some(r) = read_row(conn, &c.id)?.filter(|r| r.deleted_at.is_none()) {
                    m.insert(c.id.clone(), r.data);
                }
            }
            Ok(m)
        };
        if dry_run {
            let m = current(&self.lock())?;
            return Ok(plan_reprioritize(&m, changes, now)
                .map_err(invalid)?
                .into_iter()
                .map(|(_, d)| d)
                .collect());
        }
        let (diffs, _) = self.write(|tx| {
            let m = current(tx)?;
            let plan = plan_reprioritize(&m, changes, now).map_err(invalid)?;
            let mut diffs = vec![];
            for (item, diff) in plan {
                let before = m.get(&diff.id).cloned();
                write_row(tx, &item, None)?;
                log(
                    tx,
                    actor,
                    "reprioritize",
                    &diff.id,
                    before.as_ref(),
                    Some(&item),
                    diff.reason.as_deref(),
                )?;
                diffs.push(diff);
            }
            Ok(diffs)
        })?;
        Ok(diffs)
    }

    /// 操作记录，最新的在前
    pub fn audit(&self, limit: usize, item_id: Option<&str>) -> Result<Vec<Value>> {
        let conn = self.lock();
        let mut q = conn.prepare(
            "SELECT at, actor, action, item_id, note, before, after FROM audit_log
             WHERE (?1 IS NULL OR item_id = ?1) ORDER BY id DESC LIMIT ?2",
        )?;
        let rows = q.query_map(params![item_id, limit.min(MAX_LIMIT) as i64], |r| {
            let parse = |s: Option<String>| {
                s.and_then(|s| serde_json::from_str::<Value>(&s).ok())
                    .unwrap_or(Value::Null)
            };
            Ok(json!({
                "at": r.get::<_, f64>(0)?,
                "actor": r.get::<_, String>(1)?,
                "action": r.get::<_, String>(2)?,
                "itemId": r.get::<_, Option<String>>(3)?,
                "note": r.get::<_, Option<String>>(4)?,
                "before": parse(r.get(5)?),
                "after": parse(r.get(6)?),
            }))
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    // ------------------------------------------------------------ v1 导入

    fn import_v1(&self) -> Result<()> {
        let done: Option<String> = self
            .lock()
            .query_row(
                "SELECT value FROM meta WHERE key = 'v1_imported'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        if done.is_some() {
            return Ok(());
        }
        let src = self.dir.join("workbench.json");
        let items = if src.exists() {
            read_v1_items(&src)?
        } else {
            vec![]
        };
        let n = items.len();
        {
            let mut conn = self.lock();
            let tx = conn.transaction()?;
            let now = now_ms();
            for it in items {
                if id_of(&it).is_some() && it.is_object() {
                    upsert(&tx, it, "import-v1", now)?;
                }
            }
            if src.exists() {
                log(
                    &tx,
                    "import-v1",
                    "import",
                    "",
                    None,
                    None,
                    Some(&format!("从 workbench.json 导入 {n} 条")),
                )?;
            }
            tx.execute(
                "INSERT OR REPLACE INTO meta(key, value) VALUES ('v1_imported', ?1)",
                [now.to_string()],
            )?;
            tx.commit()?;
        }
        if src.exists() {
            let mut target = self.dir.join("workbench.v1.json");
            let mut i = 2;
            while target.exists() {
                target = self.dir.join(format!("workbench.v1-{i}.json"));
                i += 1;
            }
            fs::rename(&src, &target).map_err(|e| {
                StoreError::Unavailable(format!("导入后改名 workbench.json 失败：{e}"))
            })?;
        }
        Ok(())
    }
}

pub fn legacy_rev(rev: u64) -> String {
    format!("r{rev}")
}

// ---------------------------------------------------------------- 行读写

struct Row {
    data: Value,
    deleted_at: Option<f64>,
}

impl Row {
    /// 最后一次变化的时间（修改或删除）
    fn last_changed(&self) -> f64 {
        updated_at(&self.data).max(self.deleted_at.unwrap_or(0.0))
    }
}

fn read_row(conn: &Connection, id: &str) -> Result<Option<Row>> {
    let r = conn
        .query_row(
            "SELECT data, deleted_at FROM items WHERE id = ?1",
            [id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<f64>>(1)?)),
        )
        .optional()?;
    Ok(r.map(|(s, d)| Row {
        data: serde_json::from_str(&s).unwrap_or(Value::Null),
        deleted_at: d,
    }))
}

/// 全文索引的正文：笔记正文，加上挂在上面的问答（问答也要能搜到）
fn search_text(item: &Value) -> String {
    let mut t = str_of(item, "body").to_string();
    for q in item
        .get("qa")
        .and_then(|x| x.as_array())
        .into_iter()
        .flatten()
    {
        t.push('\n');
        t.push_str(str_of(q, "quote"));
        for turn in q
            .get("turns")
            .and_then(|x| x.as_array())
            .into_iter()
            .flatten()
        {
            t.push('\n');
            t.push_str(str_of(turn, "q"));
            t.push('\n');
            t.push_str(str_of(turn, "a"));
        }
    }
    t
}

fn write_row(tx: &Connection, item: &Value, deleted_at: Option<f64>) -> Result<()> {
    let id = id_of(item).ok_or_else(|| invalid("条目缺少 id"))?;
    let b = |k: &str| item.get(k).and_then(|x| x.as_bool()).unwrap_or(false) as i64;
    let priority = Some(str_of(item, "priority")).filter(|s| !s.is_empty());
    tx.execute(
        "INSERT INTO items (id, type, title, body, done, pinned, priority, device, created_at, updated_at, deleted_at, data)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT(id) DO UPDATE SET type = excluded.type, title = excluded.title, body = excluded.body, done = excluded.done,
           pinned = excluded.pinned, priority = excluded.priority, device = excluded.device, created_at = excluded.created_at,
           updated_at = excluded.updated_at, deleted_at = excluded.deleted_at, data = excluded.data",
        params![
            id,
            str_of(item, "type"),
            str_of(item, "title"),
            str_of(item, "body"),
            b("done"),
            b("pinned"),
            priority,
            str_of(item, "device"),
            item.get("createdAt").and_then(|x| x.as_f64()).unwrap_or(0.0),
            updated_at(item),
            deleted_at,
            item.to_string()
        ],
    )?;
    tx.execute("DELETE FROM items_fts WHERE id = ?1", [&id])?;
    if deleted_at.is_none() {
        tx.execute(
            "INSERT INTO items_fts (id, title, body) VALUES (?1, ?2, ?3)",
            params![id, str_of(item, "title"), search_text(item)],
        )?;
    }
    Ok(())
}

fn upsert(tx: &Connection, mut item: Value, actor: &str, now: f64) -> Result<()> {
    let id = id_of(&item).ok_or_else(|| invalid("条目缺少 id"))?;
    let before = read_row(tx, &id)?;
    stamp_done(before.as_ref().map(|r| &r.data), &mut item, now);
    write_row(tx, &item, None)?;
    let action = match &before {
        None => "create",
        Some(r) if r.deleted_at.is_some() => "restore",
        Some(_) => "update",
    };
    log(
        tx,
        actor,
        action,
        &id,
        before.as_ref().map(|r| &r.data),
        Some(&item),
        None,
    )
}

/// 按字段改一条：在主机上的最新内容上合并，expect 对不上就是冲突
fn patch(
    tx: &Connection,
    id: &str,
    set: Map<String, Value>,
    unset: Vec<String>,
    expect: Option<Map<String, Value>>,
    actor: &str,
    now: f64,
) -> Result<()> {
    let Some(row) = read_row(tx, id)?.filter(|r| r.deleted_at.is_none()) else {
        return Err(StoreError::NotFound(format!(
            "找不到条目 {id}（可能已经在别处删除了）"
        )));
    };
    let mut item = row.data;
    // 没有这个字段和空字符串算一样（界面上都是空）
    let norm = |v: Option<&Value>| match v {
        None | Some(Value::Null) => Value::String(String::new()),
        Some(v) => v.clone(),
    };
    for (k, v) in expect.iter().flatten() {
        if norm(item.get(k)) != norm(Some(v)) {
            return Err(StoreError::Conflict(
                "另一台电脑刚改过这条，这次修改没有保存（以免覆盖对方的内容）".into(),
            ));
        }
    }
    let Some(o) = item.as_object_mut() else {
        return Err(invalid("条目不是 JSON 对象"));
    };
    for k in &unset {
        o.remove(k);
    }
    let stamped = set.contains_key("updatedAt");
    o.extend(set);
    if !stamped {
        o.insert("updatedAt".into(), json!(now));
    }
    upsert(tx, item, actor, now)
}

/// 软删除；返回是否真的删了（本来就不存在或已删则为 false）。
/// 删掉的是父笔记时，子笔记往上挪一层（挂到它的父笔记下，没有就变成顶层），不跟着删。
fn soft_delete(tx: &Connection, id: &str, actor: &str, now: f64) -> Result<bool> {
    match read_row(tx, id)? {
        Some(r) if r.deleted_at.is_none() => {
            write_row(tx, &r.data, Some(now))?;
            log(tx, actor, "delete", id, Some(&r.data), None, None)?;
            let up = r
                .data
                .get("parentId")
                .filter(|v| v.as_str().is_some_and(|s| !s.is_empty() && s != id))
                .cloned();
            let kids = tx
                .prepare("SELECT id FROM items WHERE deleted_at IS NULL AND json_extract(data, '$.parentId') = ?1")?
                .query_map([id], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            for k in kids {
                let Some(row) = read_row(tx, &k)? else {
                    continue;
                };
                let mut item = row.data.clone();
                if let Some(o) = item.as_object_mut() {
                    match &up {
                        Some(p) => o.insert("parentId".into(), p.clone()),
                        None => o.remove("parentId"),
                    };
                    o.insert("updatedAt".into(), json!(now));
                }
                write_row(tx, &item, None)?;
                log(tx, actor, "update", &k, Some(&row.data), Some(&item), None)?;
            }
            Ok(true)
        }
        _ => Ok(false),
    }
}

/// 记一条操作记录。界面自己的修改很频繁，只记动作不存前后内容；外部 AI 的修改存完整前后内容，方便追查和撤销。
fn log(
    tx: &Connection,
    actor: &str,
    action: &str,
    item_id: &str,
    before: Option<&Value>,
    after: Option<&Value>,
    note: Option<&str>,
) -> Result<()> {
    let keep = actor != ACTOR_UI;
    tx.execute(
        "INSERT INTO audit_log (at, actor, action, item_id, note, before, after) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            now_ms(),
            actor,
            action,
            Some(item_id).filter(|s| !s.is_empty()),
            note,
            before.filter(|_| keep).map(|v| v.to_string()),
            after.filter(|_| keep).map(|v| v.to_string())
        ],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests;
