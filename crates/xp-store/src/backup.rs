//! 备份：每天第一次写入前用 SQLite 在线备份接口存一份到 backups/，保留 60 份；
//! 设置了冷备份位置（比如 8TB 盘）时，再把当天的备份和新增附件复制过去。
//! 冷备份盘没挂上就跳过，下次再补，不影响正常使用。

use crate::Store;
use rusqlite::DatabaseName;
use std::fs;
use std::path::Path;

pub const KEEP_BACKUPS: usize = 60;
/// 操作记录保留天数
pub const KEEP_AUDIT_DAYS: f64 = 365.0;

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

    /// 立即备份（同一天只保留一份），返回备份文件路径
    pub fn backup_now(&self, day: &str) -> Result<std::path::PathBuf, String> {
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
        prune(&bdir);
        let cold = self
            .cold_dir
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        if let Some(cold) = cold {
            if let Err(e) = self.copy_to_cold(&cold, &target) {
                eprintln!("冷备份跳过（{}）：{e}", cold.display());
            }
        }
        Ok(target)
    }

    fn copy_to_cold(&self, cold: &Path, today_backup: &Path) -> Result<(), String> {
        if !cold.is_dir() {
            return Err("文件夹不存在或没挂上".into());
        }
        let root = cold.join("xpanel-backup");
        let bdir = root.join("backups");
        fs::create_dir_all(&bdir).map_err(|e| e.to_string())?;
        if let Some(name) = today_backup.file_name() {
            let t = bdir.join(name);
            if !t.exists() {
                fs::copy(today_backup, &t).map_err(|e| e.to_string())?;
            }
        }
        // 附件只增不改（文件名唯一），只复制冷备份里还没有的
        if let Ok(rd) = fs::read_dir(self.dir.join("assets")) {
            let adir = root.join("assets");
            fs::create_dir_all(&adir).map_err(|e| e.to_string())?;
            for e in rd.flatten() {
                let t = adir.join(e.file_name());
                if e.path().is_file() && !t.exists() {
                    fs::copy(e.path(), &t).map_err(|e| e.to_string())?;
                }
            }
        }
        Ok(())
    }
}

fn prune(bdir: &Path) {
    let Ok(rd) = fs::read_dir(bdir) else { return };
    let mut names: Vec<_> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with("xpanel-") && n.ends_with(".db"))
                .unwrap_or(false)
        })
        .collect();
    names.sort();
    while names.len() > KEEP_BACKUPS {
        let _ = fs::remove_file(names.remove(0));
    }
}
