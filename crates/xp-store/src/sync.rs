//! 和另一个文件夹（外置硬盘、U 盘、网盘同步目录）同步整份数据，带去出差的电脑上用。
//!
//! 两边都是完整的数据文件夹（xpanel.db + assets/），同步时整份复制，谁改过用谁的：
//! - 每次同步后两边的数据库里记下同一个「同步标记」{id, rev}；
//! - 下次同步时，哪边的 rev 和标记里的不一样，就是那边改过；
//! - 只有一边改过 → 用改过的那边；两边都改过、或者从没同步过 → 让用户选，被覆盖的一边先备份到它自己的 backups/。
//! 复制用 SQLite 的在线备份接口，本机的程序开着也能得到完整一致的数据；外置硬盘那边不能同时有程序在用。
//! 附件文件名唯一、只增不改，两边互相补齐。

use crate::{schema, Result, Store, StoreError, DB_FILE};
use rusqlite::{Connection, DatabaseName, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

const MARK_KEY: &str = "sync_mark";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct Mark {
    id: String,
    rev: u64,
}

/// 一边的概况（界面上显示给用户选）
#[derive(Debug, Clone, Serialize, Default)]
pub struct SideInfo {
    pub exists: bool,
    pub rev: u64,
    /// 未删除的条目数
    pub items: u64,
    pub assets: u64,
    /// 最近一次修改条目的时间（毫秒）
    pub last_change: f64,
    /// 上次同步之后改过
    pub changed: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct SyncPlan {
    /// none：已经一致；push：本机 → 那边；pull：那边 → 本机；
    /// conflict：两边都改过；choose：从没一起同步过，要用户选方向
    pub action: String,
    pub local: SideInfo,
    pub remote: SideInfo,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SyncReport {
    /// push / pull / none
    pub action: String,
    pub assets_copied: u64,
    pub message: String,
}

fn conflict(m: impl Into<String>) -> StoreError {
    StoreError::Conflict(m.into())
}
fn io(e: impl std::fmt::Display) -> StoreError {
    StoreError::Unavailable(e.to_string())
}

fn read_mark(conn: &Connection) -> Option<Mark> {
    let v: Option<String> = conn
        .query_row("SELECT value FROM meta WHERE key = ?1", [MARK_KEY], |r| {
            r.get(0)
        })
        .optional()
        .ok()
        .flatten();
    v.and_then(|s| serde_json::from_str(&s).ok())
}
fn write_mark(conn: &Connection, m: &Mark) -> Result<()> {
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![MARK_KEY, serde_json::to_string(m).unwrap_or_default()],
    )?;
    Ok(())
}
fn read_rev(conn: &Connection) -> Result<u64> {
    Ok(conn.query_row(
        "SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'rev'",
        [],
        |r| r.get(0),
    )?)
}
fn set_rev(conn: &Connection, rev: u64) -> Result<()> {
    conn.execute(
        "UPDATE meta SET value = ?1 WHERE key = 'rev'",
        [rev.to_string()],
    )?;
    Ok(())
}

fn side_info(conn: &Connection, assets_dir: &Path) -> Result<(SideInfo, Option<Mark>)> {
    let rev = read_rev(conn)?;
    let items: u64 = conn.query_row(
        "SELECT COUNT(*) FROM items WHERE deleted_at IS NULL",
        [],
        |r| r.get(0),
    )?;
    let last: f64 = conn.query_row(
        "SELECT COALESCE(MAX(MAX(updated_at, COALESCE(deleted_at, 0))), 0) FROM items",
        [],
        |r| r.get(0),
    )?;
    let assets = fs::read_dir(assets_dir)
        .map(|rd| rd.flatten().filter(|e| e.path().is_file()).count() as u64)
        .unwrap_or(0);
    let mark = read_mark(conn);
    let changed = mark.as_ref().map(|m| m.rev != rev).unwrap_or(true);
    Ok((
        SideInfo {
            exists: true,
            rev,
            items,
            assets,
            last_change: last,
            changed,
        },
        mark,
    ))
}

/// 打开那边的数据库（不做升级、不写备份）；那边的数据库比这个程序新就拒绝
fn open_remote(dir: &Path) -> Result<Option<Connection>> {
    let p = dir.join(DB_FILE);
    if !p.is_file() {
        return Ok(None);
    }
    let c = Connection::open(&p).map_err(|e| io(format!("打不开 {}：{e}", p.display())))?;
    c.busy_timeout(std::time::Duration::from_secs(5))?;
    let v: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if v > schema::SCHEMA_VERSION {
        return Err(conflict(
            "那边的数据是更新版本的 xpanel 写的，请先把这台电脑上的 xpanel 升级到最新",
        ));
    }
    Ok(Some(c))
}

/// 把 from/assets 里有、to/assets 里没有的文件复制过去
fn copy_assets(from: &Path, to: &Path) -> Result<u64> {
    let Ok(rd) = fs::read_dir(from.join("assets")) else {
        return Ok(0);
    };
    let dst = to.join("assets");
    fs::create_dir_all(&dst).map_err(io)?;
    let mut n = 0;
    for e in rd.flatten() {
        let t = dst.join(e.file_name());
        if e.path().is_file() && !t.exists() {
            // 先写临时文件再改名：中途拔盘不会留下半个文件
            let tmp = dst.join(format!(".{}.part", e.file_name().to_string_lossy()));
            fs::copy(e.path(), &tmp)
                .map_err(|x| io(format!("复制附件 {} 失败：{x}", e.path().display())))?;
            fs::rename(&tmp, &t).map_err(io)?;
            n += 1;
        }
    }
    Ok(n)
}

fn stamp() -> String {
    let ms = xp_core::now_ms() as i64;
    format!("{}-{}", xp_core::today_local(), ms % 86_400_000 / 1000)
}

fn new_id() -> String {
    format!(
        "{:x}",
        (xp_core::now_ms() as u128) ^ (std::process::id() as u128) << 40
    )
}

impl Store {
    /// 看看和那个文件夹该怎么同步（不改任何东西）
    pub fn sync_plan(&self, dir: &Path) -> Result<SyncPlan> {
        if same_dir(self.dir(), dir) {
            return Err(StoreError::Invalid(
                "同步的文件夹就是本机的数据文件夹，换一个（比如外置硬盘上的）".into(),
            ));
        }
        let (local, lm) = {
            let conn = self.lock();
            side_info(&conn, &self.dir().join("assets"))?
        };
        let Some(rc) = open_remote(dir)? else {
            return Ok(SyncPlan {
                action: "push".into(),
                local,
                remote: SideInfo::default(),
                message: "那边还没有数据，会把本机的完整复制过去".into(),
            });
        };
        let (remote, rm) = side_info(&rc, &dir.join("assets"))?;
        let same = matches!((&lm, &rm), (Some(a), Some(b)) if a.id == b.id);
        let (action, message) = if !same {
            if remote.items == 0 {
                ("push", "那边是空的，会把本机的复制过去".to_string())
            } else if local.items == 0 {
                ("pull", "本机是空的，会用那边的数据".to_string())
            } else {
                (
                    "choose",
                    "两边都有数据，而且以前没有一起同步过，请选择用哪边的".to_string(),
                )
            }
        } else {
            match (local.changed, remote.changed) {
                (false, false) => ("none", "两边已经一致".to_string()),
                (true, false) => ("push", "本机在上次同步后改过，会复制到那边".to_string()),
                (false, true) => (
                    "pull",
                    "那边在上次同步后改过（在别的电脑上用过），会用那边的数据".to_string(),
                ),
                (true, true) => (
                    "conflict",
                    "上次同步后两边都改过，请选择保留哪边的（另一边会先备份）".to_string(),
                ),
            }
        };
        Ok(SyncPlan {
            action: action.into(),
            local,
            remote,
            message,
        })
    }

    /// 同步。direction：auto（只在不需要选择时执行）、push（本机 → 那边）、pull（那边 → 本机）
    pub fn sync_run(&self, dir: &Path, direction: &str) -> Result<SyncReport> {
        let plan = self.sync_plan(dir)?;
        let action = match direction {
            "push" | "pull" => direction.to_string(),
            _ => match plan.action.as_str() {
                "push" | "pull" | "none" => plan.action.clone(),
                _ => return Err(conflict(plan.message)),
            },
        };
        match action.as_str() {
            "push" => self.sync_push(dir),
            "pull" => self.sync_pull(dir),
            _ => {
                // 附件也补齐一下（比如上次同步中途拔了盘）
                let n = copy_assets(self.dir(), dir)? + copy_assets(dir, self.dir())?;
                if n > 0 {
                    self.register_assets();
                }
                Ok(SyncReport {
                    action: "none".into(),
                    assets_copied: n,
                    message: plan.message,
                })
            }
        }
    }

    /// 本机 → 那边
    fn sync_push(&self, dir: &Path) -> Result<SyncReport> {
        fs::create_dir_all(dir).map_err(|e| io(format!("无法访问 {}：{e}", dir.display())))?;
        // 那边原来的数据先备份在那边
        if let Some(rc) = open_remote(dir)? {
            let b = dir.join("backups");
            fs::create_dir_all(&b).map_err(io)?;
            rc.backup(
                DatabaseName::Main,
                b.join(format!("before-sync-{}.db", stamp())),
                None,
            )?;
        }
        let n = copy_assets(self.dir(), dir)?;
        let tmp = dir.join(format!("{DB_FILE}.sync-tmp"));
        {
            let conn = self.lock();
            let m = Mark {
                id: read_mark(&conn).map(|m| m.id).unwrap_or_else(new_id),
                rev: read_rev(&conn)?,
            };
            write_mark(&conn, &m)?;
            conn.backup(DatabaseName::Main, &tmp, None)?;
        }
        // 换上新的：旧的日志文件一起删掉，不然 SQLite 会把旧日志重放到新数据库上
        for f in [
            DB_FILE.to_string(),
            format!("{DB_FILE}-wal"),
            format!("{DB_FILE}-shm"),
        ] {
            let p = dir.join(&f);
            if p.exists() {
                fs::remove_file(&p).map_err(|e| {
                    io(format!(
                        "替换 {} 失败（那边是不是有 xpanel 正开着？）：{e}",
                        p.display()
                    ))
                })?;
            }
        }
        fs::rename(&tmp, dir.join(DB_FILE)).map_err(io)?;
        Ok(SyncReport {
            action: "push".into(),
            assets_copied: n,
            message: format!("已把本机的数据复制到 {}", dir.display()),
        })
    }

    /// 那边 → 本机（本机原来的数据先备份到本机的 backups/）
    fn sync_pull(&self, dir: &Path) -> Result<SyncReport> {
        let Some(rc) = open_remote(dir)? else {
            return Err(StoreError::NotFound(format!(
                "{} 里没有 xpanel 数据",
                dir.display()
            )));
        };
        let n = copy_assets(dir, self.dir())?;
        let b = self.dir().join("backups");
        fs::create_dir_all(&b).map_err(io)?;
        let rev = {
            let mut conn = self.lock();
            let old_rev = read_rev(&conn)?;
            conn.backup(
                DatabaseName::Main,
                b.join(format!("before-sync-{}.db", stamp())),
                None,
            )?;
            let remote_rev = read_rev(&rc)?;
            let id = read_mark(&rc).map(|m| m.id).unwrap_or_else(new_id);
            drop(rc);
            conn.restore(
                DatabaseName::Main,
                dir.join(DB_FILE),
                None::<fn(rusqlite::backup::Progress)>,
            )?;
            schema::migrate(&conn)?;
            // rev 取两边都没用过的新值，界面一定会刷新；两边记下同一个标记
            let rev = old_rev.max(remote_rev) + 1;
            let tx = conn.transaction()?;
            set_rev(&tx, rev)?;
            write_mark(
                &tx,
                &Mark {
                    id: id.clone(),
                    rev,
                },
            )?;
            tx.commit()?;
            let rc = open_remote(dir)?.ok_or_else(|| io("那边的数据库不见了"))?;
            set_rev(&rc, rev)?;
            write_mark(&rc, &Mark { id, rev })?;
            rev
        };
        self.register_assets();
        let _ = self.events.send(rev);
        Ok(SyncReport {
            action: "pull".into(),
            assets_copied: n,
            message: format!(
                "已换成 {} 里的数据（本机原来的备份在 backups/）",
                dir.display()
            ),
        })
    }
}

fn same_dir(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => a == b,
    }
}
