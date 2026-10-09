//! 备份：每天第一次写入前用 SQLite 在线备份接口存一份到 backups/，保留 60 份；
//! 设置了冷备份位置（比如大容量硬盘）时，再在后台把当天的备份和新增附件复制过去。
//! 冷备份盘没挂上就跳过，下次再补，不影响正常使用。
//!
//! 一键备份（`backup_to_drive`）：马上做一份完整快照，连同附件复制到外置硬盘上的文件夹
//! （`set_drive_dir`；没单独设置时就是冷备份位置），最后写 `latest.json` 记下这份快照
//! （有它就说明这份快照和附件都齐了）。别的电脑从这里按条目合并（见 `sync.rs`）。
//!
//! 冷备份位置、外置硬盘文件夹的结构：
//! ```text
//! <文件夹>/xpanel-backup/
//!   backups/xpanel-YYYY-MM-DD.db            每天自动的
//!   snapshots/xpanel-YYYY-MM-DD-HHMMSS-<标识>.db  一键备份的，保留 6 份
//!   assets/                                 附件，只增不删
//!   latest.json                             最近一次一键备份（哪台电脑、哪份快照）
//! ```

use crate::{Result, Store, StoreError};
use rusqlite::DatabaseName;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

pub const KEEP_BACKUPS: usize = 60;
/// 一键备份的快照保留份数
pub const KEEP_SNAPSHOTS: usize = 6;
/// 操作记录保留天数
pub const KEEP_AUDIT_DAYS: f64 = 365.0;
/// 冷备份位置下的文件夹名
pub const COLD_ROOT: &str = "xpanel-backup";
const MANIFEST: &str = "latest.json";

impl Store {
    /// 当天还没备份就备份一次（打开时和每次写入前调用）
    pub(crate) fn daily_backup(&self) {
        let today = xp_core::today_local();
        {
            let mut last = self.backed_up_day.lock().unwrap_or_else(|e| e.into_inner());
            if *last == today {
                return;
            }
            *last = today.clone();
        }
        if let Err(e) = self.backup_now(&today) {
            eprintln!("备份失败：{e}");
        }
    }

    /// 立即备份到 backups/（同一天只保留一份），返回备份文件路径。
    /// 设置了冷备份位置时，在后台复制过去（用 `wait_cold_copy` 等它做完）
    pub fn backup_now(&self, day: &str) -> std::result::Result<PathBuf, String> {
        let bdir = self.dir.join("backups");
        fs::create_dir_all(&bdir).map_err(|e| e.to_string())?;
        let target = bdir.join(format!("xpanel-{day}.db"));
        if !target.exists() {
            let conn = self.lock();
            conn.backup(DatabaseName::Main, &target, None)
                .map_err(|e| e.to_string())?;
            let cutoff = xp_core::now_ms() - KEEP_AUDIT_DAYS * 86_400_000.0;
            let _ = conn.execute("DELETE FROM audit_log WHERE at < ?1", [cutoff]);
        }
        prune(&bdir, "xpanel-", KEEP_BACKUPS);
        self.spawn_cold_copy(target.clone());
        Ok(target)
    }

    pub fn cold_backup_dir(&self) -> Option<PathBuf> {
        self.cold_dir
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// 后台把每日备份和新附件复制到冷备份位置；上一次还没复制完就不再开新的
    fn spawn_cold_copy(&self, daily: PathBuf) {
        let Some(cold) = self.cold_backup_dir() else {
            return;
        };
        let mut job = self.cold_job.lock().unwrap_or_else(|e| e.into_inner());
        if job.as_ref().is_some_and(|h| !h.is_finished()) {
            return;
        }
        let (dir, busy) = (self.dir.clone(), self.cold_busy.clone());
        *job = Some(std::thread::spawn(move || {
            let _g = busy.lock().unwrap_or_else(|e| e.into_inner());
            if let Err(e) = copy_daily_to_cold(&dir, &cold, &daily) {
                eprintln!("冷备份跳过（{}）：{e}", cold.display());
            }
        }));
    }

    /// 等后台的冷备份复制做完
    pub fn wait_cold_copy(&self) {
        let h = self
            .cold_job
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        if let Some(h) = h {
            let _ = h.join();
        }
    }

    /// 外置硬盘文件夹下的 xpanel-backup/（确认设置了、盘也插着）
    pub(crate) fn drive_root_ready(&self) -> Result<PathBuf> {
        let drive = self.drive_dir().ok_or_else(|| {
            StoreError::Invalid("还没设置外置硬盘上的文件夹，先填一个（比如 F:\\xpanel）".into())
        })?;
        if same_dir(&drive, &self.dir) {
            return Err(StoreError::Invalid(
                "外置硬盘上的文件夹就是本机的数据文件夹，换一个".into(),
            ));
        }
        if !drive_available(&drive) {
            return Err(StoreError::Unavailable(format!(
                "文件夹 {} 不在，外置硬盘插上了吗？",
                drive.display()
            )));
        }
        Ok(drive.join(COLD_ROOT))
    }

    /// 备份状态：备份位置、在不在、是不是正在复制、最近一次一键备份、
    /// 本机是谁、上次和外置硬盘对齐的是哪份、要不要先合并
    pub fn backup_status(&self) -> Result<Value> {
        let cold = self.drive_dir();
        let last = cold
            .as_ref()
            .and_then(|c| read_manifest(&c.join(COLD_ROOT)));
        let (id, name) = self.replica()?;
        let base = self.sync_base()?;
        Ok(json!({
            "dir": cold.as_ref().map(|c| c.display().to_string()),
            "available": cold.as_ref().is_some_and(|c| drive_available(c)),
            "running": self.cold_busy.try_lock().is_err(),
            "last": last,
            "replica": { "id": id, "name": name },
            "base": base,
            "needsMerge": last.as_ref().is_some_and(|l| needs_merge(l, &base, &id)),
        }))
    }

    /// 一键备份：数据库完整快照 + 补齐附件，都写到外置硬盘上的文件夹，这份快照也成为本机的同步点。
    /// 外置硬盘上的最新备份来自别的电脑、本机还没合并过时，先不备份（返回 needsMerge），
    /// 免得那边的改动被盖掉；force = true 时照样备份。
    /// 附件多时会花一阵子；正在自动复制时先等它做完。
    pub fn backup_to_drive(&self, force: bool) -> Result<Value> {
        let root = self.drive_root_ready()?;
        let fail = |e: std::io::Error| StoreError::Unavailable(format!("备份失败：{e}"));
        let _g = self.cold_busy.lock().unwrap_or_else(|e| e.into_inner());
        let (replica_id, replica_name) = self.replica()?;
        if let Some(latest) = read_manifest(&root) {
            if !force && needs_merge(&latest, &self.sync_base()?, &replica_id) {
                return Ok(json!({ "needsMerge": true, "latest": latest }));
            }
        }
        let started = xp_core::now_ms();
        let sdir = root.join("snapshots");
        fs::create_dir_all(&sdir).map_err(fail)?;
        sweep_parts(&sdir);
        // 带上数据文件夹标识：两台电脑的快照不会重名
        let name = format!("xpanel-{}-{replica_id}.db", xp_core::stamp_local());
        let part = sdir.join(format!(".{name}.part"));
        // 拿着数据库锁做快照，rev 和条数与快照内容一致
        let (rev, items) = {
            let conn = self.lock();
            let rev: u64 = conn.query_row(
                "SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'rev'",
                [],
                |r| r.get(0),
            )?;
            let items: u64 = conn.query_row(
                "SELECT COUNT(*) FROM items WHERE deleted_at IS NULL",
                [],
                |r| r.get(0),
            )?;
            conn.backup(DatabaseName::Main, &part, None)
                .map_err(|e| StoreError::Unavailable(format!("备份数据库失败：{e}")))?;
            (rev, items)
        };
        fs::rename(&part, sdir.join(&name)).map_err(fail)?;
        let a = sync_assets(&self.dir.join("assets"), &root.join("assets")).map_err(fail)?;
        let manifest = json!({
            "version": 1,
            "at": xp_core::now_ms(),
            "file": format!("snapshots/{name}"),
            "rev": rev,
            "items": items,
            "assets": a.total_files,
            "assetBytes": a.total_bytes,
            "replicaId": replica_id,
            "replicaName": replica_name,
            "host": host_name(),
            "dataDir": self.dir.display().to_string(),
        });
        let mpart = root.join(format!(".{MANIFEST}.part"));
        fs::write(
            &mpart,
            serde_json::to_string_pretty(&manifest).unwrap_or_default(),
        )
        .map_err(fail)?;
        fs::rename(&mpart, root.join(MANIFEST)).map_err(fail)?;
        self.set_sync_base(&sdir.join(&name), &manifest)?;
        prune(&sdir, "xpanel-", KEEP_SNAPSHOTS);
        Ok(json!({
            "dir": root.display().to_string(),
            "manifest": manifest,
            "copiedFiles": a.copied_files,
            "copiedBytes": a.copied_bytes,
            "tookMs": xp_core::now_ms() - started,
        }))
    }
}

/// 外置硬盘上的最新备份来自别的电脑，而本机上次对齐的不是它：要先合并
fn needs_merge(latest: &Value, base: &Value, me: &str) -> bool {
    let file = latest.get("file").and_then(|v| v.as_str()).unwrap_or("");
    let from = latest
        .get("replicaId")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let base_file = base.get("file").and_then(|v| v.as_str()).unwrap_or("");
    !file.is_empty() && file != base_file && from != me
}

/// xpanel-backup/latest.json
pub(crate) fn read_manifest(root: &Path) -> Option<Value> {
    fs::read_to_string(root.join(MANIFEST))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .filter(|v| v.is_object())
}

fn copy_daily_to_cold(dir: &Path, cold: &Path, daily: &Path) -> std::result::Result<(), String> {
    if !cold.is_dir() {
        return Err("文件夹不存在或没挂上".into());
    }
    let root = cold.join(COLD_ROOT);
    let bdir = root.join("backups");
    fs::create_dir_all(&bdir).map_err(|e| e.to_string())?;
    if let Some(name) = daily.file_name() {
        let t = bdir.join(name);
        if !t.exists() {
            copy_atomic(daily, &t).map_err(|e| e.to_string())?;
        }
    }
    sync_assets(&dir.join("assets"), &root.join("assets")).map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Default)]
pub(crate) struct AssetSync {
    pub total_files: u64,
    pub total_bytes: u64,
    pub copied_files: u64,
    pub copied_bytes: u64,
}

/// 附件只增不改（文件名唯一）：只复制目标里没有的，或者大小对不上的（上次没复制完）
pub(crate) fn sync_assets(src: &Path, dst: &Path) -> std::io::Result<AssetSync> {
    let mut s = AssetSync::default();
    let Ok(rd) = fs::read_dir(src) else {
        return Ok(s);
    };
    fs::create_dir_all(dst)?;
    sweep_parts(dst);
    for e in rd.flatten() {
        let Ok(meta) = e.metadata() else { continue };
        let name = e.file_name();
        if !meta.is_file() || name.to_string_lossy().starts_with('.') {
            continue;
        }
        s.total_files += 1;
        s.total_bytes += meta.len();
        let t = dst.join(&name);
        if t.metadata().map(|m| m.len()).ok() != Some(meta.len()) {
            copy_atomic(&e.path(), &t)?;
            s.copied_files += 1;
            s.copied_bytes += meta.len();
        }
    }
    Ok(s)
}

/// 先复制到 .xxx.part 再改名：中途拔盘不会留下看起来完整的半截文件
pub(crate) fn copy_atomic(src: &Path, dst: &Path) -> std::io::Result<()> {
    let name = dst.file_name().unwrap_or_default().to_string_lossy();
    let part = dst.with_file_name(format!(".{name}.part"));
    fs::copy(src, &part)?;
    fs::rename(&part, dst)
}

/// 清掉上次中断留下的 .part
fn sweep_parts(dir: &Path) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let n = e.file_name().to_string_lossy().to_string();
        if n.starts_with('.') && n.ends_with(".part") {
            let _ = fs::remove_file(e.path());
        }
    }
}

pub(crate) fn host_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_default()
}

pub(crate) fn prune(dir: &Path, prefix: &str, keep: usize) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    let mut names: Vec<_> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with(prefix) && n.ends_with(".db"))
                .unwrap_or(false)
        })
        .collect();
    names.sort();
    while names.len() > keep {
        let _ = fs::remove_file(names.remove(0));
    }
}

/// 外置硬盘上的文件夹在不在。文件夹还没建、但上一层在（盘插着），也算在：备份时会建出来
fn drive_available(dir: &Path) -> bool {
    dir.is_dir() || dir.parent().is_some_and(|p| p.is_dir())
}

fn same_dir(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => a == b,
    }
}
