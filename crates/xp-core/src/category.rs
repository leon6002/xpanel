//! 分类与标签的规则。
//!
//! - 分类：每条最多一个，用 `/` 分层，如 `工作/AutoSAR`（最多 5 层）。存在条目的 `category` 字段。
//!   选中一个分类时，它的子分类里的条目也算在内。
//! - 标签：每条可以有多个（`tags` 字段），不分层，不能有空格。

pub const MAX_DEPTH: usize = 5;
const MAX_SEG: usize = 30;

/// 规整分类路径：去掉多余的空白和斜杠，`\` 也当分隔符；空的返回 None
pub fn normalize_category(s: &str) -> Result<Option<String>, String> {
    let segs: Vec<&str> = s
        .split(['/', '\\'])
        .map(str::trim)
        .filter(|x| !x.is_empty())
        .collect();
    if segs.is_empty() {
        return Ok(None);
    }
    if segs.len() > MAX_DEPTH {
        return Err(format!("分类最多 {MAX_DEPTH} 层"));
    }
    for g in &segs {
        if g.chars().count() > MAX_SEG {
            return Err(format!("分类名每层不超过 {MAX_SEG} 个字：{g}"));
        }
        if g.contains(['#', '@', '\n', '\r', '\t']) {
            return Err(format!("分类名不能有 # @ 和换行：{g}"));
        }
    }
    Ok(Some(segs.join("/")))
}

/// 条目的分类 `item` 是否在 `cat` 下面（包括它自己和所有子分类）
pub fn in_category(item: &str, cat: &str) -> bool {
    item == cat
        || (item.len() > cat.len() && item.starts_with(cat) && item.as_bytes()[cat.len()] == b'/')
}

/// 分类改名 / 移动：`path` 在 `from` 下面就换成 `to` 开头，否则返回 None
pub fn rename_path(path: &str, from: &str, to: &str) -> Option<String> {
    if path == from {
        Some(to.to_string())
    } else if in_category(path, from) {
        Some(format!("{to}{}", &path[from.len()..]))
    } else {
        None
    }
}

/// 一个路径和它所有上级：工作/AutoSAR/配置 → [工作, 工作/AutoSAR, 工作/AutoSAR/配置]
pub fn with_ancestors(path: &str) -> Vec<String> {
    let mut out = vec![];
    let mut cur = String::new();
    for seg in path.split('/') {
        if !cur.is_empty() {
            cur.push('/');
        }
        cur.push_str(seg);
        out.push(cur.clone());
    }
    out
}

pub fn parent_of(path: &str) -> Option<&str> {
    path.rfind('/').map(|i| &path[..i])
}

/// 规整一个标签：去掉 #、首尾空白；不能有空白
pub fn normalize_tag(s: &str) -> Result<String, String> {
    let t = s.trim().trim_start_matches('#').trim();
    if t.is_empty() {
        return Err("标签不能为空".into());
    }
    if t.contains(char::is_whitespace) || t.contains(['#', '@']) || t.chars().count() > 40 {
        return Err(format!("标签不超过 40 个字，不能有空格、# 和 @：{t}"));
    }
    Ok(t.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths() {
        assert_eq!(
            normalize_category(" 工作 / AutoSAR/ ").unwrap().as_deref(),
            Some("工作/AutoSAR")
        );
        assert_eq!(
            normalize_category("工作\\周报").unwrap().as_deref(),
            Some("工作/周报")
        );
        assert_eq!(normalize_category(" / ").unwrap(), None);
        assert!(normalize_category("a/b/c/d/e/f").is_err());
        assert!(normalize_category("有#号").is_err());
        assert!(in_category("工作/AutoSAR", "工作"));
        assert!(in_category("工作", "工作"));
        assert!(!in_category("工作记录", "工作"));
        assert!(!in_category("工作", "工作/AutoSAR"));
        assert_eq!(
            rename_path("工作/AutoSAR/配置", "工作/AutoSAR", "项目/AUTOSAR").as_deref(),
            Some("项目/AUTOSAR/配置")
        );
        assert_eq!(rename_path("工作记录", "工作", "x"), None);
        assert_eq!(with_ancestors("a/b/c"), ["a", "a/b", "a/b/c"]);
        assert_eq!(parent_of("a/b"), Some("a"));
        assert_eq!(parent_of("a"), None);
        assert_eq!(normalize_tag(" #周报 ").unwrap(), "周报");
        assert!(normalize_tag("两个 词").is_err());
    }
}
