//! 桌面版：把笔记展开成项目目录（给 AI 当工作目录）、随笔记更新同步、生成「继续」的提示词。
//! 文件都写在这台电脑上；附件从本机数据库（主机模式）或主机（连接模式）读。

use crate::{blocking, client, AppState, St};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use xp_core::templates::Template;
use xp_workspace::{self as ws, Create};

fn default_root() -> PathBuf {
    if cfg!(windows) && Path::new("D:\\codes").is_dir() {
        return PathBuf::from("D:\\codes");
    }
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join("codes")
}

fn host_url(st: &AppState) -> String {
    let c = st.cfg();
    if c.mode == "host" {
        format!("http://127.0.0.1:{}", c.port)
    } else {
        c.server_url.clone()
    }
}

fn read_asset(st: &Arc<AppState>, name: &str) -> Result<Vec<u8>, String> {
    let c = st.cfg();
    match c.mode.as_str() {
        "host" => st.host_store()?.get_asset(name).map_err(|e| e.to_string()),
        "client" => client::get_asset(&c.server_url, name),
        _ => Err("还没有设置".into()),
    }
}

/// 建议的项目名和目录
#[tauri::command]
pub async fn workspace_defaults(
    title: String,
    item_id: String,
    root: Option<String>,
) -> Result<Value, String> {
    blocking(move || {
        let root = root.filter(|r| !r.trim().is_empty()).map(PathBuf::from).unwrap_or_else(default_root);
        let name = ws::suggest_name(&title);
        let path = ws::suggest_path(&root, &name, &item_id);
        let name = path.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or(name);
        Ok(json!({"root": root.display().to_string(), "name": name, "path": path.display().to_string(), "defaultRoot": default_root().display().to_string()}))
    })
    .await
}

/// 检查项目名，返回完整路径和这个目录能不能用
#[tauri::command]
pub async fn workspace_check(root: String, name: String, item_id: String) -> Result<Value, String> {
    blocking(move || {
        let name = ws::validate_name(&name)?;
        let path = Path::new(root.trim()).join(&name);
        let state = match ws::read_manifest(&path) {
            Ok(m) if m.item_id == item_id => "ours",
            Ok(_) => "other",
            Err(_) if !path.exists() => "new",
            Err(_)
                if std::fs::read_dir(&path)
                    .map(|mut r| r.next().is_none())
                    .unwrap_or(false) =>
            {
                "new"
            }
            Err(_) => "busy",
        };
        Ok(json!({"path": path.display().to_string(), "state": state}))
    })
    .await
}

/// 新建（或重用）项目目录并同步一次
#[tauri::command]
pub async fn workspace_prepare(
    s: St<'_>,
    item: Value,
    root: String,
    name: String,
    template: Template,
    git: bool,
) -> Result<Value, String> {
    let st = s.inner().clone();
    blocking(move || {
        let root = PathBuf::from(root.trim());
        std::fs::create_dir_all(&root).map_err(|e| format!("创建 {} 失败：{e}", root.display()))?;
        let host = host_url(&st);
        let (path, ch) = ws::sync(
            None,
            Some(Create { root: &root, name: &name, template, host: &host, git }),
            &item,
            &|a| read_asset(&st, a),
        )?;
        let images = ws::read_manifest(&path).map(|m| m.synced.images).unwrap_or(0);
        Ok(json!({"path": path.display().to_string(), "summary": ch.summary(images), "changes": ch}))
    })
    .await
}

/// 笔记有更新时同步（条目的 updatedAt 和上次同步时一样就什么都不做）
#[tauri::command]
pub async fn workspace_sync(
    s: St<'_>,
    item: Value,
    path: String,
    force: Option<bool>,
) -> Result<Value, String> {
    let st = s.inner().clone();
    blocking(move || {
        let dir = PathBuf::from(&path);
        let m = ws::read_manifest(&dir)?;
        let rev = item
            .get("updatedAt")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        if !force.unwrap_or(false) && m.synced_rev == rev {
            return Ok(json!({"skipped": true}));
        }
        let (_, ch) = ws::sync(Some(&dir), None, &item, &|a| read_asset(&st, a))?;
        let images = ws::read_manifest(&dir)
            .map(|m| m.synced.images)
            .unwrap_or(0);
        Ok(json!({"summary": ch.summary(images), "changes": ch, "empty": ch.is_empty()}))
    })
    .await
}

/// 交给 AI 之前：生成提示词（第一次是模板的开场白，之后只说新增了什么）。record=true 时记下这次交到哪了
#[tauri::command]
pub async fn workspace_handoff(path: String, record: bool) -> Result<Value, String> {
    blocking(move || {
        let dir = PathBuf::from(&path);
        let m = ws::read_manifest(&dir)?;
        let (p, ch) = ws::next_prompt(&dir)?;
        if record {
            ws::mark_handed(&dir)?;
        }
        let summary = if ch.first { "第一次交给 AI".to_string() } else { ch.summary(m.synced.images) };
        Ok(json!({"prompt": p, "summary": summary, "first": ch.first, "empty": !ch.first && ch.is_empty()}))
    })
    .await
}
