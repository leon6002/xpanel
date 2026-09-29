//! 导出：Markdown（给人和 AI 读）、CSV（给表格软件）、JSON（给程序）

use crate::{bool_of, is_checkable, local_date_of, str_of, tags_of, type_label, ITEM_TYPES};
use serde_json::{json, Value};

/// 按类型分组的 Markdown。可勾选的类型用任务列表，其余用小标题；
/// 每条末尾带 `<!-- id:… -->`，AI 读完可以按 id 写回。
pub fn export_markdown(items: &[Value], title: &str) -> String {
    let mut out = format!("# {title}\n\n共 {} 条\n", items.len());
    let mut types: Vec<&str> = ITEM_TYPES.iter().map(|t| t.0).collect();
    for it in items {
        let t = str_of(it, "type");
        if !types.contains(&t) {
            types.push(t);
        }
    }
    for t in types {
        let group: Vec<&Value> = items.iter().filter(|x| str_of(x, "type") == t).collect();
        if group.is_empty() {
            continue;
        }
        out += &format!("\n## {}（{}）\n\n", type_label(t), group.len());
        for it in group {
            let body = str_of(it, "body").trim();
            let meta = meta_line(it);
            if is_checkable(t) {
                let check = if bool_of(it, "done") { "x" } else { " " };
                out += &format!(
                    "- [{check}] {}{meta} <!-- id:{} -->\n",
                    one_line(str_of(it, "title")),
                    str_of(it, "id")
                );
                for line in body.lines() {
                    out += &format!("  {line}\n");
                }
            } else {
                out += &format!("### {}\n\n", one_line(str_of(it, "title")));
                if !meta.trim().is_empty() {
                    out += &format!("{}\n\n", meta.trim());
                }
                if !body.is_empty() {
                    out += &format!("{body}\n\n");
                }
                out += &format!("<!-- id:{} -->\n\n", str_of(it, "id"));
            }
        }
    }
    out
}

fn one_line(s: &str) -> String {
    s.replace(['\r', '\n'], " ")
}

fn meta_line(it: &Value) -> String {
    let mut parts = vec![];
    let p = str_of(it, "priority");
    if !p.is_empty() {
        parts.push(format!("`{p}`"));
    }
    if bool_of(it, "pinned") {
        parts.push("置顶".into());
    }
    let cat = str_of(it, "category");
    if !cat.is_empty() {
        parts.push(format!("分类 {cat}"));
    }
    let due = str_of(it, "due");
    if !due.is_empty() {
        parts.push(format!("截止 {due}"));
    }
    for t in tags_of(it) {
        parts.push(format!("#{t}"));
    }
    let d = str_of(it, "device");
    if !d.is_empty() {
        parts.push(format!("@{d}"));
    }
    if parts.is_empty() {
        String::new()
    } else {
        format!(" · {}", parts.join(" "))
    }
}

const CSV_COLS: &[&str] = &[
    "id",
    "type",
    "category",
    "title",
    "priority",
    "done",
    "pinned",
    "tags",
    "due",
    "device",
    "createdAt",
    "updatedAt",
    "doneAt",
    "createdBy",
    "body",
];

/// 带 BOM 的 CSV，Excel 直接打开中文不乱码；时间列是本地时间
pub fn export_csv(items: &[Value]) -> String {
    let mut out = String::from("\u{feff}");
    out += &CSV_COLS.join(",");
    out += "\r\n";
    for it in items {
        let row: Vec<String> = CSV_COLS
            .iter()
            .map(|c| match *c {
                "tags" => tags_of(it).join(" "),
                "done" | "pinned" => bool_of(it, c).to_string(),
                "createdAt" | "updatedAt" | "doneAt" => it
                    .get(*c)
                    .and_then(|v| v.as_f64())
                    .and_then(|ms| {
                        chrono::TimeZone::timestamp_millis_opt(&chrono::Local, ms as i64).single()
                    })
                    .map(|d| d.format("%Y-%m-%d %H:%M").to_string())
                    .unwrap_or_default(),
                _ => match it.get(*c) {
                    Some(Value::String(s)) => s.clone(),
                    Some(Value::Null) | None => String::new(),
                    Some(v) => v.to_string(),
                },
            })
            .map(|s| csv_cell(&s))
            .collect();
        out += &row.join(",");
        out += "\r\n";
    }
    out
}

fn csv_cell(s: &str) -> String {
    // 以 = + - @ 开头的内容加单引号，防止表格软件当公式执行
    let s = if s.starts_with(['=', '+', '-', '@']) {
        format!("'{s}")
    } else {
        s.to_string()
    };
    if s.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s
    }
}

pub fn export_json(items: &[Value], exported_at: f64) -> Value {
    json!({
        "exportedAt": exported_at,
        "exportedDate": local_date_of(exported_at).map(|d| d.to_string()),
        "count": items.len(),
        "items": items,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Vec<Value> {
        vec![
            json!({"id":"a","type":"todo","title":"写周报","priority":"P1","tags":["周报"],"due":"2026-10-08","body":"第一行\n第二行","done":false}),
            json!({"id":"b","type":"note","title":"会议记录","body":"内容, 有逗号 \"引号\""}),
            json!({"id":"c","type":"todo","title":"=1+1","done":true}),
        ]
    }

    #[test]
    fn markdown_groups_and_ids() {
        let md = export_markdown(&sample(), "导出");
        assert!(md.contains("## 待办（2）"));
        assert!(md.contains("- [ ] 写周报 · `P1` 截止 2026-10-08 #周报 <!-- id:a -->"));
        assert!(md.contains("  第二行"));
        assert!(md.contains("- [x] =1+1"));
        assert!(md.contains("### 会议记录"));
        assert!(md.find("## 待办").unwrap() < md.find("## 笔记").unwrap());
    }

    #[test]
    fn csv_quotes_and_formula_guard() {
        let csv = export_csv(&sample());
        assert!(csv.starts_with('\u{feff}'));
        assert!(csv.contains("\"内容, 有逗号 \"\"引号\"\"\""));
        assert!(csv.contains("'=1+1"));
        assert_eq!(csv.lines().count(), 4 + 1); // 表头 + 3 行，第一条正文里有换行被引号包住
    }
}
