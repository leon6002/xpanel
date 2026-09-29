//! 把一条笔记（或任何条目）展开成一个项目目录，给 AI 当工作目录用，并随笔记更新同步。
//!
//! ```text
//! <根目录>/<项目名>/
//!   CLAUDE.md  AGENTS.md    只在第一次生成：告诉 AI 先读 .xpanel/TASK.md。之后归项目所有，不再覆盖
//!   .gitignore              加一行 .xpanel/
//!   .xpanel/                xpanel 管理，AI 只读
//!     TASK.md               目标（来自模板）、材料清单、怎么汇报；每次同步重写
//!     note.md               笔记原文，图片链接指向 images/
//!     images/01.png …       截图。编号第一次出现时分配，之后固定，新图往后编
//!     files/                其他附件
//!     更新记录.md           每次同步有变化就追加一条
//!     manifest.json         条目 id、编号表、上次同步 / 上次交给 AI 时的状态
//! ```

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use xp_core::templates::Template;
use xp_core::{str_of, tags_of};

pub const DIR: &str = ".xpanel";
const MANIFEST: &str = "manifest.json";
const LOG: &str = "更新记录.md";

// ---------------------------------------------------------------- 项目名

/// 项目名：字母、数字、- _ .，不以 . 或 - 开头，最长 64，不能是 Windows 保留名
pub fn validate_name(name: &str) -> Result<String, String> {
    let n = name.trim();
    if n.is_empty() {
        return Err("项目名不能为空".into());
    }
    if n.chars().count() > 64 {
        return Err("项目名太长（最多 64 个字符）".into());
    }
    if !n
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
    {
        return Err("项目名只能用英文字母、数字和 - _ .".into());
    }
    if n.starts_with(['.', '-']) || n.ends_with('.') {
        return Err("项目名不能以 . 或 - 开头，也不能以 . 结尾".into());
    }
    let stem = n.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = ["CON", "PRN", "AUX", "NUL"];
    if reserved.contains(&stem.as_str())
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && stem.as_bytes()[3].is_ascii_digit())
    {
        return Err("这个名字在 Windows 上不能用作文件夹名".into());
    }
    Ok(n.to_string())
}

const STOP: &[&str] = &[
    "a", "an", "the", "to", "of", "for", "and", "or", "in", "on", "at", "with", "my", "this",
    "that", "remember", "todo", "note", "notes", "please", "about", "from", "is", "are", "be",
];

fn slug_words(words: impl Iterator<Item = String>, max: usize) -> String {
    let mut out: Vec<String> = vec![];
    for w in words {
        let w = w.to_ascii_lowercase();
        if w.is_empty() || STOP.contains(&w.as_str()) || out.contains(&w) {
            continue;
        }
        out.push(w);
        if out.len() >= max {
            break;
        }
    }
    out.join("-")
}

/// 从标题给一个建议的项目名：取第一个标点前的那句；有英文词就用英文词（去掉 to/the 这类），
/// 纯中文就转成拼音。例：「leap motor code, remember to …」→ leap-motor-code，「CAN 报文解析」→ can-baowen-jiexi
pub fn suggest_name(title: &str) -> String {
    let head = title
        .split(|c: char| ",，。.:：;；!！?？()（）[]【】|/\\\n".contains(c))
        .map(str::trim)
        .find(|s| !s.is_empty())
        .unwrap_or("");
    let ascii: Vec<String> = head
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| w.chars().any(|c| c.is_ascii_alphabetic()))
        .map(String::from)
        .collect();
    let has_han = head.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c));
    let name = if !ascii.is_empty() && (!has_han || ascii.len() >= 2) {
        slug_words(ascii.into_iter(), 4)
    } else {
        // 中文：英文词原样，汉字转拼音，最多 4 段
        use pinyin::ToPinyin;
        // (文字, 是不是汉字转的拼音)
        let mut parts: Vec<(String, bool)> = vec![];
        let mut buf = String::new();
        for c in head.chars() {
            if c.is_ascii_alphanumeric() {
                buf.push(c);
                continue;
            }
            if !buf.is_empty() {
                parts.push((std::mem::take(&mut buf), false));
            }
            if let Some(p) = c.to_pinyin() {
                parts.push((p.plain().to_string(), true));
            }
        }
        if !buf.is_empty() {
            parts.push((buf, false));
        }
        // 连续的汉字两个一组拼起来（报文 → baowen），读起来更像词
        let mut words: Vec<String> = vec![];
        let mut i = 0;
        while i < parts.len() {
            let (a, ha) = &parts[i];
            match parts.get(i + 1) {
                Some((b, true)) if *ha && a.len() + b.len() <= 12 => {
                    words.push(format!("{a}{b}"));
                    i += 2;
                }
                _ => {
                    words.push(a.clone());
                    i += 1;
                }
            }
        }
        slug_words(words.into_iter(), 4)
    };
    let name: String = name.chars().take(48).collect();
    let name = name.trim_matches('-').to_string();
    if validate_name(&name).is_ok() {
        name
    } else {
        "new-project".into()
    }
}

/// 建议的目录：根目录/项目名；已被别的东西占用就加 -2、-3
pub fn suggest_path(root: &Path, name: &str, item_id: &str) -> PathBuf {
    let mut n = 1;
    loop {
        let cand = if n == 1 {
            root.join(name)
        } else {
            root.join(format!("{name}-{n}"))
        };
        match read_manifest(&cand) {
            Ok(m) if m.item_id == item_id => return cand,
            _ if !cand.exists() => return cand,
            _ => n += 1,
        }
    }
}

// ---------------------------------------------------------------- 清单

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Baseline {
    /// 已有的最大截图编号
    pub images: u32,
    /// 文字段落的指纹
    pub paragraphs: Vec<String>,
    pub at: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Manifest {
    pub version: u32,
    pub item_id: String,
    pub name: String,
    pub title: String,
    pub host: String,
    pub template: Template,
    pub created_at: String,
    /// 资源名 → 截图编号（固定不变）
    pub images: BTreeMap<String, u32>,
    /// 上次同步时条目的 updatedAt
    pub synced_rev: f64,
    pub synced: Baseline,
    /// 上次交给 AI 时的状态（「继续」时只交这之后新增的）
    pub handed: Option<Baseline>,
}

pub fn read_manifest(project: &Path) -> Result<Manifest, String> {
    let p = project.join(DIR).join(MANIFEST);
    let s = fs::read_to_string(&p)
        .map_err(|_| format!("{} 不是 xpanel 生成的项目", project.display()))?;
    serde_json::from_str(&s).map_err(|e| format!("{} 格式有误：{e}", p.display()))
}

fn write_manifest(project: &Path, m: &Manifest) -> Result<(), String> {
    let s = serde_json::to_string_pretty(m).map_err(|e| e.to_string())?;
    write_if_changed(&project.join(DIR).join(MANIFEST), &s)
}

/// 从某个目录往上找 xpanel 项目的根（有 .xpanel/manifest.json 的那层）
pub fn find_project(start: &Path) -> Option<PathBuf> {
    let mut cur = Some(start);
    while let Some(d) = cur {
        if d.join(DIR).join(MANIFEST).is_file() {
            return Some(d.to_path_buf());
        }
        cur = d.parent();
    }
    None
}

// ---------------------------------------------------------------- 笔记内容

/// 正文里引用的附件（按出现顺序，去重）
pub fn asset_refs(body: &str) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    let mut rest = body;
    while let Some(i) = rest.find("](asset:") {
        let tail = &rest[i + 8..];
        let end = tail
            .find(|c: char| !(c.is_ascii_alphanumeric() || "._-".contains(c)))
            .unwrap_or(tail.len());
        let name = &tail[..end];
        if !name.is_empty() && !out.iter().any(|x| x == name) {
            out.push(name.to_string());
        }
        rest = &tail[end..];
    }
    out
}

pub fn is_image(name: &str) -> bool {
    matches!(
        ext_of(name).as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "avif" | "heic"
    )
}

fn ext_of(name: &str) -> String {
    name.rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .filter(|e| e.len() <= 8 && e.chars().all(|c| c.is_ascii_alphanumeric()))
        .unwrap_or_else(|| "bin".into())
}

pub fn image_file(n: u32, asset: &str) -> String {
    format!("{n:02}.{}", ext_of(asset))
}

/// 文字段落（空行分隔；只有图片的段落不算），用来比较新增了哪些文字
fn paragraphs(body: &str) -> Vec<(String, String)> {
    let mut out = vec![];
    for p in body.replace("\r\n", "\n").split("\n\n") {
        let text: String = p
            .lines()
            .filter(|l| !(l.trim_start().starts_with("![") && l.contains("](asset:")))
            .collect::<Vec<_>>()
            .join("\n");
        let t = text.trim();
        if t.is_empty() {
            continue;
        }
        let h = Sha256::digest(t.as_bytes());
        out.push((
            h.iter().take(8).map(|b| format!("{b:02x}")).collect(),
            t.to_string(),
        ));
    }
    out
}

/// note.md：附件链接改成相对路径，去掉图片大小标记（![说明|480]）
fn render_note(item: &Value, images: &BTreeMap<String, u32>) -> String {
    let body = str_of(item, "body");
    let mut out = String::new();
    let mut rest = body;
    while let Some(i) = rest.find("](asset:") {
        let (before, tail) = rest.split_at(i);
        let tail = &tail[8..];
        let end = tail
            .find(|c: char| !(c.is_ascii_alphanumeric() || "._-".contains(c)))
            .unwrap_or(tail.len());
        let name = &tail[..end];
        // 去掉 alt 末尾的 |480
        let before = match before.rfind('|') {
            Some(j)
                if before[j + 1..].chars().all(|c| c.is_ascii_digit())
                    && !before[j + 1..].is_empty() =>
            {
                &before[..j]
            }
            _ => before,
        };
        out.push_str(before);
        out.push_str("](");
        match images.get(name) {
            Some(n) => out.push_str(&format!("images/{}", image_file(*n, name))),
            None => out.push_str(&format!("files/{name}")),
        }
        rest = &tail[end..];
    }
    out.push_str(rest);
    let mut head = format!("# {}\n", str_of(item, "title"));
    let meta = meta_line(item);
    if !meta.is_empty() {
        head += &format!("\n> {meta}\n");
    }
    format!("{head}\n{}\n", out.trim_end())
}

fn meta_line(item: &Value) -> String {
    let mut m = vec![];
    if !str_of(item, "category").is_empty() {
        m.push(format!("分类：{}", str_of(item, "category")));
    }
    let tags = tags_of(item);
    if !tags.is_empty() {
        m.push(format!(
            "标签：{}",
            tags.iter()
                .map(|t| format!("#{t}"))
                .collect::<Vec<_>>()
                .join(" ")
        ));
    }
    if !str_of(item, "device").is_empty() {
        m.push(format!("设备：{}", str_of(item, "device")));
    }
    if !str_of(item, "priority").is_empty() {
        m.push(format!("优先级：{}", str_of(item, "priority")));
    }
    if !str_of(item, "due").is_empty() {
        m.push(format!("截止：{}", str_of(item, "due")));
    }
    m.join(" · ")
}

fn render_task(item: &Value, m: &Manifest) -> String {
    let id = str_of(item, "id");
    let max = m.images.values().max().copied().unwrap_or(0);
    let imgs = if max == 0 {
        "（暂无）".to_string()
    } else if max == 1 {
        ".xpanel/images/01.*".into()
    } else {
        format!(".xpanel/images/01 … {max:02}（编号固定，新截图往后编；实际先后顺序看 note.md）")
    };
    let meta = meta_line(item);
    format!(
        "# 任务：{title}\n\n\
> 这个文件由 xpanel 生成，笔记更新时会重写，不要改它。项目自己的约定写在根目录的 CLAUDE.md / AGENTS.md。\n\
> 来源：xpanel 条目 `{id}`{meta}\n\n\
## 目标\n\n{goal}\n\n\
## 材料\n\n\
- 笔记原文：.xpanel/note.md（图片链接指向 .xpanel/images/）\n\
- 截图：{imgs}\n\
- 其他附件：.xpanel/files/\n\
- 更新记录：.xpanel/{LOG}——笔记会持续补充，每次同步追加一条，写明新增了什么\n\n\
## 做事方式\n\n\
- .xpanel/ 只读；产出直接写在项目里。\n\
- 开始工作和每次继续之前，先调用 xpanel MCP 的 `xpanel_workspace_sync` 拉取最新笔记（没有 MCP 就直接读 .xpanel/）。\n\
- 有阶段性进展、做完或卡住时，调用 `xpanel_report`（itemId: `{id}`）回写：做了什么、结论、还缺什么。\n",
        title = str_of(item, "title"),
        meta = if meta.is_empty() { String::new() } else { format!(" · {meta}") },
        goal = m.template.goal.trim(),
    )
}

fn render_agents(item: &Value, name: &str) -> String {
    format!(
        "# {name}\n\n\
这个项目由 xpanel 笔记「{title}」生成。\n\n\
- 开始工作前先读 `.xpanel/TASK.md`（目标、完成标准、怎么汇报）和 `.xpanel/note.md`（原始笔记和截图）。\n\
- `.xpanel/` 由 xpanel 管理，不要修改。笔记会持续更新，变化记在 `.xpanel/更新记录.md`。\n\
- 进展和结论用 xpanel MCP 的 `xpanel_report` 回写（条目 id：`{id}`）。\n\n\
## 项目约定\n\n\
（在这里补充这个项目自己的约定：怎么构建、怎么测试、代码风格…）\n",
        title = str_of(item, "title"),
        id = str_of(item, "id"),
    )
}

// ---------------------------------------------------------------- 文件

fn write_if_changed(p: &Path, s: &str) -> Result<(), String> {
    if fs::read_to_string(p).map(|old| old == s).unwrap_or(false) {
        return Ok(());
    }
    if let Some(d) = p.parent() {
        fs::create_dir_all(d).map_err(|e| format!("创建 {} 失败：{e}", d.display()))?;
    }
    fs::write(p, s).map_err(|e| format!("写入 {} 失败：{e}", p.display()))
}

fn now() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M").to_string()
}

/// 一次同步（或相对上次交给 AI）的变化
#[derive(Serialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Changes {
    pub first: bool,
    /// 新增截图的编号
    pub new_images: Vec<u32>,
    pub new_files: Vec<String>,
    /// 新增（或改过）的文字段落
    pub new_text: Vec<String>,
    /// 删掉（或改掉）的段落数
    pub removed_text: usize,
    /// 读不到的附件
    pub missing: Vec<String>,
}

impl Changes {
    pub fn is_empty(&self) -> bool {
        !self.first
            && self.new_images.is_empty()
            && self.new_files.is_empty()
            && self.new_text.is_empty()
            && self.removed_text == 0
    }
    /// 一句话概括，如「新增 16–19 号截图、2 段文字」
    pub fn summary(&self, images_total: u32) -> String {
        if self.first {
            return format!("首次生成：{images_total} 张截图");
        }
        let mut p = vec![];
        if !self.new_images.is_empty() {
            let (a, b) = (self.new_images[0], *self.new_images.last().unwrap());
            p.push(if a == b {
                format!("{a:02} 号截图")
            } else if b - a + 1 == self.new_images.len() as u32 {
                format!("{a:02}–{b:02} 号截图")
            } else {
                format!("{} 张截图", self.new_images.len())
            });
        }
        if !self.new_text.is_empty() {
            p.push(format!("{} 段文字", self.new_text.len()));
        }
        if !self.new_files.is_empty() {
            p.push(format!("{} 个附件", self.new_files.len()));
        }
        let mut s = if p.is_empty() {
            String::new()
        } else {
            format!("新增 {}", p.join("、"))
        };
        if self.removed_text > 0 {
            if !s.is_empty() {
                s += "，";
            }
            s += &format!("删改了 {} 段文字", self.removed_text);
        }
        if s.is_empty() {
            "没有变化".into()
        } else {
            s
        }
    }
}

fn diff(
    base: &Baseline,
    images_now: u32,
    paras: &[(String, String)],
) -> (Vec<u32>, Vec<String>, usize) {
    let new_images: Vec<u32> = (base.images + 1..=images_now).collect();
    let new_text: Vec<String> = paras
        .iter()
        .filter(|(h, _)| !base.paragraphs.contains(h))
        .map(|(_, t)| t.clone())
        .collect();
    let removed = base
        .paragraphs
        .iter()
        .filter(|h| !paras.iter().any(|(x, _)| x == *h))
        .count();
    (new_images, new_text, removed)
}

/// 新建时用的参数
pub struct Create<'a> {
    pub root: &'a Path,
    pub name: &'a str,
    pub template: Template,
    pub host: &'a str,
    pub git: bool,
}

/// 生成（或同步）项目。`create` 为 None 时 `project` 必须是已有的项目目录。
/// `assets` 读附件内容。返回项目目录和这次同步的变化。
pub fn sync(
    project: Option<&Path>,
    create: Option<Create>,
    item: &Value,
    assets: &dyn Fn(&str) -> Result<Vec<u8>, String>,
) -> Result<(PathBuf, Changes), String> {
    let id = str_of(item, "id");
    if id.is_empty() {
        return Err("条目缺少 id".into());
    }
    let (dir, mut m, first) = match (project, &create) {
        (_, Some(c)) => {
            let name = validate_name(c.name)?;
            let dir = c.root.join(&name);
            match read_manifest(&dir) {
                Ok(mut m) if m.item_id == id => {
                    m.template = c.template.clone();
                    (dir, m, false)
                }
                Ok(_) => {
                    return Err(format!(
                        "{} 已经是另一条笔记的项目，换个名字",
                        dir.display()
                    ))
                }
                Err(_) => {
                    if dir.exists()
                        && fs::read_dir(&dir)
                            .map(|mut r| r.next().is_some())
                            .unwrap_or(false)
                    {
                        return Err(format!(
                            "{} 已经存在而且不是空文件夹，换个名字",
                            dir.display()
                        ));
                    }
                    fs::create_dir_all(&dir)
                        .map_err(|e| format!("创建 {} 失败：{e}", dir.display()))?;
                    let m = Manifest {
                        version: 1,
                        item_id: id.to_string(),
                        name: name.clone(),
                        host: c.host.to_string(),
                        template: c.template.clone(),
                        created_at: now(),
                        ..Default::default()
                    };
                    (dir, m, true)
                }
            }
        }
        (Some(p), None) => {
            let m = read_manifest(p)?;
            if m.item_id != id {
                return Err("这个项目不是这条笔记的".into());
            }
            (p.to_path_buf(), m, false)
        }
        (None, None) => return Err("没有指定项目目录".into()),
    };
    let x = dir.join(DIR);
    // 附件：新图分配下一个编号；已编号的图文件不在了就补回来
    let body = str_of(item, "body");
    let mut changes = Changes {
        first,
        ..Default::default()
    };
    let mut next = m.images.values().max().copied().unwrap_or(0);
    for a in asset_refs(body) {
        if is_image(&a) {
            let n = match m.images.get(&a) {
                Some(n) => *n,
                None => {
                    next += 1;
                    next
                }
            };
            let path = x.join("images").join(image_file(n, &a));
            if !path.is_file() {
                match assets(&a) {
                    Ok(bytes) => {
                        fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
                        fs::write(&path, bytes)
                            .map_err(|e| format!("写入 {} 失败：{e}", path.display()))?;
                    }
                    Err(_) => {
                        changes.missing.push(a.clone());
                        if !m.images.contains_key(&a) {
                            next -= 1;
                        }
                        continue;
                    }
                }
            }
            m.images.entry(a).or_insert(n);
        } else {
            let path = x.join("files").join(&a);
            if !path.is_file() {
                match assets(&a) {
                    Ok(bytes) => {
                        fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
                        fs::write(&path, bytes).map_err(|e| e.to_string())?;
                        if !first {
                            changes.new_files.push(a.clone());
                        }
                    }
                    Err(_) => changes.missing.push(a.clone()),
                }
            }
        }
    }
    let images_now = m.images.values().max().copied().unwrap_or(0);
    let paras = paragraphs(body);
    if !first {
        let (ni, nt, rm) = diff(&m.synced, images_now, &paras);
        changes.new_images = ni;
        changes.new_text = nt;
        changes.removed_text = rm;
    }
    m.title = str_of(item, "title").to_string();
    write_if_changed(&x.join("note.md"), &render_note(item, &m.images))?;
    write_if_changed(&x.join("TASK.md"), &render_task(item, &m))?;
    if first {
        for f in ["CLAUDE.md", "AGENTS.md"] {
            let p = dir.join(f);
            if !p.exists() {
                write_if_changed(&p, &render_agents(item, &m.name))?;
            }
        }
        let gi = dir.join(".gitignore");
        let old = fs::read_to_string(&gi).unwrap_or_default();
        if !old
            .lines()
            .any(|l| l.trim() == ".xpanel/" || l.trim() == ".xpanel")
        {
            let sep = if old.is_empty() || old.ends_with('\n') {
                ""
            } else {
                "\n"
            };
            write_if_changed(
                &gi,
                &format!("{old}{sep}# xpanel 管理的笔记和截图（可随时重新生成）\n.xpanel/\n"),
            )?;
        }
        if create.as_ref().is_some_and(|c| c.git) && !dir.join(".git").exists() {
            git_init(&dir);
        }
    }
    if !changes.is_empty() {
        let mut entry = format!("\n## {}\n\n- {}\n", now(), changes.summary(images_now));
        if !changes.new_images.is_empty() && !first {
            let names: Vec<String> = changes
                .new_images
                .iter()
                .filter_map(|n| {
                    m.images
                        .iter()
                        .find(|(_, v)| *v == n)
                        .map(|(a, _)| format!("images/{}", image_file(*n, a)))
                })
                .collect();
            entry += &format!("- 截图：{}\n", names.join("、"));
        }
        for t in &changes.new_text {
            let quoted: Vec<String> = t.lines().map(|l| format!("  > {l}")).collect();
            entry += &format!("- 文字：\n{}\n", quoted.join("\n"));
        }
        let lp = x.join(LOG);
        let old = fs::read_to_string(&lp).unwrap_or_else(|_| {
            format!(
                "# 更新记录\n\n笔记「{}」每次同步有变化时追加一条，最新的在最下面。\n",
                m.title
            )
        });
        write_if_changed(&lp, &format!("{old}{entry}"))?;
    }
    m.synced = Baseline {
        images: images_now,
        paragraphs: paras.iter().map(|(h, _)| h.clone()).collect(),
        at: now(),
    };
    m.synced_rev = item
        .get("updatedAt")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    write_manifest(&dir, &m)?;
    Ok((dir, changes))
}

fn git_init(dir: &Path) {
    let mut cmd = std::process::Command::new("git");
    cmd.arg("init").arg("-q").current_dir(dir);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // 不弹黑窗口
    }
    let _ = cmd.output();
}

/// 算出自上次交给 AI 以来的变化和该用的提示词（不记录）
pub fn next_prompt(project: &Path) -> Result<(String, Changes), String> {
    let m = read_manifest(project)?;
    let t = &m.template;
    Ok(match &m.handed {
        None => (
            t.prompt.clone(),
            Changes {
                first: true,
                ..Default::default()
            },
        ),
        Some(base) => {
            let new_images: Vec<u32> = (base.images + 1..=m.synced.images).collect();
            let new_text: Vec<String> = m
                .synced
                .paragraphs
                .iter()
                .filter(|h| !base.paragraphs.contains(h))
                .cloned()
                .collect();
            let removed_text = base
                .paragraphs
                .iter()
                .filter(|h| !m.synced.paragraphs.contains(h))
                .count();
            let ch = Changes {
                new_images,
                new_text,
                removed_text,
                ..Default::default()
            };
            let p = if ch.is_empty() {
                "继续之前的工作。先看一下 .xpanel/TASK.md 和你上次留下的进展，告诉我现在到哪一步了。".to_string()
            } else {
                format!(
                    "笔记有更新：{}，详见 .xpanel/{LOG} 最后几条（上次交给你是 {}）。{}",
                    ch.summary(m.synced.images),
                    base.at,
                    t.resume
                )
            };
            (p, ch)
        }
    })
}

/// 记下「已经交给 AI 到这里了」
pub fn mark_handed(project: &Path) -> Result<(), String> {
    let mut m = read_manifest(project)?;
    m.handed = Some(m.synced.clone());
    write_manifest(project, &m)
}

/// 交给 AI：返回提示词并记录
pub fn handoff(project: &Path) -> Result<(String, Changes), String> {
    let r = next_prompt(project)?;
    mark_handed(project)?;
    Ok(r)
}

#[cfg(test)]
mod tests;
