//! 附件：存在数据文件夹的 assets/ 下，文件名由界面生成（只允许字母数字和 ._-）

use crate::{Result, Store, StoreError};
use rusqlite::params;
use std::fs;

pub fn safe_asset_name(n: &str) -> Result<String> {
    let ok = !n.is_empty()
        && n.len() <= 120
        && !n.starts_with('.')
        && n.chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c));
    if ok {
        Ok(n.to_string())
    } else {
        Err(StoreError::Invalid("附件文件名不合法".into()))
    }
}

pub fn mime_of(n: &str) -> &'static str {
    match n
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "pdf" => "application/pdf",
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "zip" => "application/zip",
        "txt" | "md" => "text/plain; charset=utf-8",
        "json" => "application/json",
        _ => "application/octet-stream",
    }
}

impl Store {
    pub fn put_asset(&self, name: &str, bytes: &[u8]) -> Result<String> {
        let name = safe_asset_name(name)?;
        let dir = self.dir.join("assets");
        fs::create_dir_all(&dir)
            .map_err(|e| StoreError::Unavailable(format!("保存附件失败：{e}")))?;
        fs::write(dir.join(&name), bytes)
            .map_err(|e| StoreError::Unavailable(format!("保存附件失败：{e}")))?;
        self.lock().execute(
            "INSERT OR REPLACE INTO assets(name, mime, size, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![name, mime_of(&name), bytes.len() as i64, xp_core::now_ms()],
        )?;
        Ok(name)
    }

    pub fn get_asset(&self, name: &str) -> Result<Vec<u8>> {
        let name = safe_asset_name(name)?;
        fs::read(self.dir.join("assets").join(&name))
            .map_err(|e| StoreError::NotFound(format!("读取附件失败：{e}")))
    }

    /// 把 assets/ 里已有但没登记的文件（v1 留下的）登记进表
    pub(crate) fn register_assets(&self) {
        let Ok(rd) = fs::read_dir(self.dir.join("assets")) else {
            return;
        };
        let conn = self.lock();
        for e in rd.flatten() {
            let Ok(meta) = e.metadata() else { continue };
            if !meta.is_file() {
                continue;
            }
            let name = e.file_name().to_string_lossy().to_string();
            if safe_asset_name(&name).is_err() {
                continue;
            }
            let at = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as f64)
                .unwrap_or(0.0);
            let _ = conn.execute(
                "INSERT OR IGNORE INTO assets(name, mime, size, created_at) VALUES (?1, ?2, ?3, ?4)",
                params![name, mime_of(&name), meta.len() as i64, at],
            );
        }
    }
}
