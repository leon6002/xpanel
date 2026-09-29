//! 命令行和 MCP 共用：把笔记展开成项目目录、同步、生成「继续」的提示词、回写进展。

use crate::Client;
use serde_json::{json, Value};
use std::io::Read;
use std::path::{Path, PathBuf};
use xp_core::templates::{pick, Template};
use xp_workspace::{self as ws, Create};

pub fn hostname() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .or_else(|| {
            std::fs::read_to_string("/etc/hostname")
                .ok()
                .map(|s| s.trim().to_string())
        })
        .unwrap_or_default()
}

/// 默认的项目根目录：Windows 上有 D:\codes 就用它，否则用户目录下的 codes
pub fn default_root() -> PathBuf {
    if cfg!(windows) && Path::new("D:\\codes").is_dir() {
        return PathBuf::from("D:\\codes");
    }
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join("codes")
}

impl Client {
    /// 读附件原始内容（/api/asset/<名字>）
    pub fn asset(&self, name: &str) -> Result<Vec<u8>, String> {
        let r = ureq::get(&format!(
            "{}/api/asset/{}",
            self.base.trim_end_matches('/'),
            name
        ))
        .timeout(std::time::Duration::from_secs(120))
        .call()
        .map_err(|e| format!("读取附件 {name} 失败：{e}"))?;
        let mut buf = vec![];
        r.into_reader()
            .take(200_000_000)
            .read_to_end(&mut buf)
            .map_err(|e| e.to_string())?;
        Ok(buf)
    }
}

fn item(c: &Client, id: &str) -> Result<Value, String> {
    c.get(&format!("/items/{}", crate::mcp::enc(id)), &[])
}

fn template(c: &Client, id: &str) -> Template {
    let list: Vec<Template> = c
        .get("/templates", &[])
        .ok()
        .and_then(|v| serde_json::from_value(v["templates"].clone()).ok())
        .unwrap_or_else(xp_core::templates::builtin);
    pick(&list, id)
}

/// 在条目上记下「这台电脑上的项目目录」
fn record(c: &Client, it: &Value, path: &Path, name: &str) -> Result<(), String> {
    let host = hostname();
    let p = path.display().to_string();
    let mut list: Vec<Value> = it["workspaces"].as_array().cloned().unwrap_or_default();
    list.retain(|w| {
        !(w["path"] == p.as_str()
            || (!host.is_empty()
                && w["hostname"] == host.as_str()
                && w["deviceId"].as_str().unwrap_or("").is_empty()))
    });
    list.push(json!({"hostname": host, "path": p, "name": name, "createdAt": xp_core::now_ms(), "by": "xp"}));
    c.send(
        "PATCH",
        &format!("/items/{}", crate::mcp::enc(xp_core::str_of(it, "id"))),
        json!({"workspaces": list}),
    )?;
    Ok(())
}

pub struct Created {
    pub path: PathBuf,
    pub summary: String,
    pub missing: Vec<String>,
}

pub fn create(
    c: &Client,
    id: &str,
    name: Option<&str>,
    root: Option<&str>,
    template_id: &str,
    git: bool,
) -> Result<Created, String> {
    let it = item(c, id)?;
    let name = match name.map(str::trim).filter(|s| !s.is_empty()) {
        Some(n) => ws::validate_name(n)?,
        None => ws::suggest_name(xp_core::str_of(&it, "title")),
    };
    let root = root.map(PathBuf::from).unwrap_or_else(default_root);
    std::fs::create_dir_all(&root).map_err(|e| format!("创建 {} 失败：{e}", root.display()))?;
    let dir = ws::suggest_path(&root, &name, id);
    let name = dir
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or(name);
    let (path, ch) = ws::sync(
        None,
        Some(Create {
            root: &root,
            name: &name,
            template: template(c, template_id),
            host: &c.base,
            git,
        }),
        &it,
        &|a| c.asset(a),
    )?;
    record(c, &it, &path, &name)?;
    let images = ws::read_manifest(&path)
        .map(|m| m.synced.images)
        .unwrap_or(0);
    Ok(Created {
        path,
        summary: ch.summary(images),
        missing: ch.missing,
    })
}

/// 同步：project 为 None 时从当前目录往上找
pub fn sync(
    c: &Client,
    project: Option<&str>,
) -> Result<(PathBuf, xp_workspace::Changes, u32), String> {
    let start = match project {
        Some(p) => PathBuf::from(p),
        None => std::env::current_dir().map_err(|e| e.to_string())?,
    };
    let dir = ws::find_project(&start).ok_or_else(|| {
        format!(
            "{} 不在 xpanel 生成的项目里（找不到 .xpanel/manifest.json）",
            start.display()
        )
    })?;
    let m = ws::read_manifest(&dir)?;
    let it = item(c, &m.item_id)?;
    let (dir, ch) = ws::sync(Some(&dir), None, &it, &|a| c.asset(a))?;
    let images = ws::read_manifest(&dir)
        .map(|m| m.synced.images)
        .unwrap_or(0);
    Ok((dir, ch, images))
}

/// 当前目录所在项目对应的条目 id
pub fn item_of_cwd() -> Option<String> {
    let d = ws::find_project(&std::env::current_dir().ok()?)?;
    ws::read_manifest(&d).ok().map(|m| m.item_id)
}
