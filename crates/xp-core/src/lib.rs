//! xpanel 核心：条目模型、操作、优先级、导出与统计。
//!
//! 这里只放纯逻辑，不读写文件、不访问网络，方便单独测试。
//! 条目仍是自由 JSON（和 v1 兼容）：常用字段有固定含义，其余字段原样保留。
//!
//! 常用字段：`id` `type` `title` `body` `tags` `device` `done` `pinned`
//! `createdAt` `updatedAt`（毫秒时间戳）`priority`（P0–P3）`due`（YYYY-MM-DD）
//! `rank`（手动排序，越小越靠前）`doneAt` `createdBy` `agentLog`

use chrono::{Datelike, Local, TimeZone};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

pub mod category;
pub mod device;
pub mod export;
pub mod stats;
pub mod templates;
pub mod wechat;

pub use export::{export_csv, export_json, export_markdown};
pub use stats::stats;

/// 条目类型：(内部名, 中文名, 是否可勾选完成)
pub const ITEM_TYPES: &[(&str, &str, bool)] = &[
    ("todo", "待办", true),
    ("issue", "问题", true),
    ("idea", "灵感", true),
    ("note", "笔记", false),
    ("link", "入口", false),
    ("rule", "规范与工作流", false),
    // 随手发进来、还没归类的（收件箱）
    ("inbox", "收件箱", false),
];

pub const PRIORITIES: &[&str] = &["P0", "P1", "P2", "P3"];

pub fn type_label(t: &str) -> &str {
    ITEM_TYPES
        .iter()
        .find(|x| x.0 == t)
        .map(|x| x.1)
        .unwrap_or(t)
}

pub fn is_checkable(t: &str) -> bool {
    ITEM_TYPES.iter().any(|x| x.0 == t && x.2)
}

// ---------------------------------------------------------------- 操作（v1 协议，旧界面和连接模式在用）

#[derive(Deserialize, Serialize, Debug, Clone, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Op {
    Upsert {
        item: Value,
    },
    Delete {
        id: String,
    },
    Import {
        items: Vec<Value>,
    },
    /// 只改几个字段（其他字段以主机上的为准，不会被这边的旧数据盖掉）。
    /// expect：这些字段在主机上应该还是这个值，否则说明别处刚改过，拒绝（冲突）
    Patch {
        id: String,
        #[serde(default)]
        set: Map<String, Value>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        unset: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        expect: Option<Map<String, Value>>,
    },
}

/// 只检查操作本身：不合格的操作无论重试多少次都会失败
pub fn validate_op(op: &Op) -> Result<(), String> {
    match op {
        Op::Upsert { item } if id_of(item).is_none() => Err("条目缺少 id".into()),
        Op::Upsert { item } if !item.is_object() => Err("条目必须是 JSON 对象".into()),
        Op::Delete { id } if id.is_empty() => Err("要删除的条目缺少 id".into()),
        Op::Patch { id, .. } if id.is_empty() => Err("要修改的条目缺少 id".into()),
        Op::Patch { set, unset, .. }
            if set.contains_key("id") || unset.iter().any(|k| k == "id") =>
        {
            Err("不能改条目的 id".into())
        }
        _ => Ok(()),
    }
}

// ---------------------------------------------------------------- 字段读取

pub fn id_of(v: &Value) -> Option<String> {
    v.get("id")
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
        .map(String::from)
}
pub fn str_of<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("")
}
pub fn num_of(v: &Value, k: &str) -> f64 {
    v.get(k).and_then(|x| x.as_f64()).unwrap_or(0.0)
}
pub fn bool_of(v: &Value, k: &str) -> bool {
    v.get(k).and_then(|x| x.as_bool()).unwrap_or(false)
}
pub fn tags_of(v: &Value) -> Vec<String> {
    v.get("tags")
        .and_then(|x| x.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|t| t.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}
pub fn updated_at(v: &Value) -> f64 {
    num_of(v, "updatedAt")
}

// ---------------------------------------------------------------- 时间与 id

pub fn now_ms() -> f64 {
    chrono::Utc::now().timestamp_millis() as f64
}

/// 本地日期 YYYY-MM-DD
pub fn today_local() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

pub use chrono::NaiveDate;

pub fn today_date() -> NaiveDate {
    Local::now().date_naive()
}

pub fn local_date_of(ms: f64) -> Option<NaiveDate> {
    Local
        .timestamp_millis_opt(ms as i64)
        .single()
        .map(|d| d.date_naive())
}

/// 和界面同样格式的 id：毫秒时间戳的 36 进制 + 5 位随机
pub fn new_id() -> String {
    let mut b = [0u8; 8];
    let _ = getrandom::getrandom(&mut b);
    let mut r = u64::from_le_bytes(b);
    let mut tail = String::new();
    for _ in 0..5 {
        tail.push(char::from_digit((r % 36) as u32, 36).unwrap());
        r /= 36;
    }
    format!("{}{}", to_base36(now_ms() as u64), tail)
}

fn to_base36(mut n: u64) -> String {
    if n == 0 {
        return "0".into();
    }
    let mut s = vec![];
    while n > 0 {
        s.push(char::from_digit((n % 36) as u32, 36).unwrap());
        n /= 36;
    }
    s.iter().rev().collect()
}

// ---------------------------------------------------------------- 优先级与截止日期

/// 接受 P0–P3、0–3、以及常见说法（urgent/high/medium/low、紧急/高/中/低）
pub fn normalize_priority(s: &str) -> Option<String> {
    let t = s.trim();
    let u = t.to_ascii_uppercase();
    let p = match u.as_str() {
        "P0" | "0" | "URGENT" | "CRITICAL" => "P0",
        "P1" | "1" | "HIGH" => "P1",
        "P2" | "2" | "MEDIUM" | "NORMAL" => "P2",
        "P3" | "3" | "LOW" => "P3",
        _ => match t {
            "紧急" => "P0",
            "高" => "P1",
            "中" | "普通" => "P2",
            "低" => "P3",
            _ => return None,
        },
    };
    Some(p.to_string())
}

/// 截止日期统一存成 YYYY-MM-DD；也接受毫秒时间戳
pub fn normalize_due(v: &Value) -> Result<Option<String>, String> {
    match v {
        Value::Null => Ok(None),
        Value::String(s) if s.trim().is_empty() => Ok(None),
        Value::String(s) => {
            let d = s.trim().get(..10).unwrap_or(s);
            NaiveDate::parse_from_str(d, "%Y-%m-%d")
                .map(|d| Some(d.format("%Y-%m-%d").to_string()))
                .map_err(|_| format!("截止日期格式不对：{s}（要 YYYY-MM-DD）"))
        }
        Value::Number(n) => n
            .as_f64()
            .and_then(local_date_of)
            .map(|d| Some(d.format("%Y-%m-%d").to_string()))
            .ok_or_else(|| "截止日期不对".into()),
        _ => Err("截止日期格式不对（要 YYYY-MM-DD）".into()),
    }
}

// ---------------------------------------------------------------- 新建与修改（对外 API 用）

/// 通过 API 新建条目时的输入
#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct NewItem {
    /// 传了 id 就是幂等写入：同一个 id 重复提交只会更新，不会多出一条
    pub id: Option<String>,
    #[serde(rename = "type")]
    pub kind: Option<String>,
    pub title: String,
    pub body: Option<String>,
    pub tags: Option<Vec<String>>,
    /// 分类路径，如 工作/AutoSAR
    pub category: Option<String>,
    pub priority: Option<String>,
    pub due: Option<Value>,
    pub device: Option<String>,
    pub pinned: Option<bool>,
    pub rank: Option<f64>,
    /// 其他自定义字段，原样存下
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl NewItem {
    pub fn into_item(self, now: f64, created_by: &str) -> Result<Value, String> {
        let kind = self.kind.unwrap_or_else(|| "todo".into());
        if !ITEM_TYPES.iter().any(|t| t.0 == kind) {
            return Err(format!(
                "未知的类型 {kind}，可选：{}",
                ITEM_TYPES
                    .iter()
                    .map(|t| t.0)
                    .collect::<Vec<_>>()
                    .join(" / ")
            ));
        }
        let title = self.title.trim().to_string();
        if title.is_empty() {
            return Err("标题不能为空".into());
        }
        let mut o = self.extra;
        for k in ["done", "createdAt", "updatedAt", "doneAt", "deletedAt"] {
            o.remove(k);
        }
        o.insert(
            "id".into(),
            json!(self.id.filter(|s| !s.is_empty()).unwrap_or_else(new_id)),
        );
        o.insert("type".into(), json!(kind));
        o.insert("title".into(), json!(title));
        o.insert("body".into(), json!(self.body.unwrap_or_default()));
        o.insert(
            "tags".into(),
            json!(clean_tags(self.tags.unwrap_or_default())),
        );
        o.insert("device".into(), json!(self.device.unwrap_or_default()));
        o.insert("done".into(), json!(false));
        o.insert("pinned".into(), json!(self.pinned.unwrap_or(false)));
        o.insert("createdAt".into(), json!(now));
        o.insert("updatedAt".into(), json!(now));
        if !created_by.is_empty() {
            o.insert("createdBy".into(), json!(created_by));
        }
        if let Some(p) = self.priority.filter(|p| !p.trim().is_empty()) {
            o.insert(
                "priority".into(),
                json!(normalize_priority(&p).ok_or_else(|| bad_priority(&p))?),
            );
        }
        if let Some(d) = self.due {
            if let Some(d) = normalize_due(&d)? {
                o.insert("due".into(), json!(d));
            }
        }
        if let Some(r) = self.rank {
            o.insert("rank".into(), json!(r));
        }
        if let Some(c) = self.category {
            if let Some(c) = category::normalize_category(&c)? {
                o.insert("category".into(), json!(c));
            }
        }
        Ok(Value::Object(o))
    }
}

fn bad_priority(p: &str) -> String {
    format!("优先级 {p} 看不懂，可选 P0 / P1 / P2 / P3")
}

fn clean_tags(tags: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    for t in tags {
        let t = t.trim().trim_start_matches('#').trim().to_string();
        if !t.is_empty() && !out.contains(&t) {
            out.push(t);
        }
    }
    out
}

/// 按字段修改条目：值为 null 表示删除该字段；id 和 createdAt 不能改
pub fn apply_patch(item: &mut Value, patch: &Map<String, Value>, now: f64) -> Result<(), String> {
    let o = item.as_object_mut().ok_or("条目数据损坏")?;
    for (k, v) in patch {
        match k.as_str() {
            "id" | "createdAt" | "createdBy" | "deletedAt" => continue,
            "updatedAt" | "doneAt" => continue,
            "type" => {
                let t = v.as_str().unwrap_or("");
                if !ITEM_TYPES.iter().any(|x| x.0 == t) {
                    return Err(format!("未知的类型 {t}"));
                }
                o.insert(k.clone(), v.clone());
            }
            "title" => {
                let t = v.as_str().map(str::trim).unwrap_or("");
                if t.is_empty() {
                    return Err("标题不能为空".into());
                }
                o.insert(k.clone(), json!(t));
            }
            "priority" => match v {
                Value::Null => {
                    o.remove(k);
                }
                _ => {
                    let s = v
                        .as_str()
                        .map(String::from)
                        .unwrap_or_else(|| v.to_string());
                    o.insert(
                        k.clone(),
                        json!(normalize_priority(&s).ok_or_else(|| bad_priority(&s))?),
                    );
                }
            },
            "due" => match normalize_due(v)? {
                Some(d) => {
                    o.insert(k.clone(), json!(d));
                }
                None => {
                    o.remove(k);
                }
            },
            "category" => match v
                .as_str()
                .map(category::normalize_category)
                .transpose()?
                .flatten()
            {
                Some(c) => {
                    o.insert(k.clone(), json!(c));
                }
                None => {
                    o.remove(k);
                }
            },
            "tags" => {
                let tags: Vec<String> =
                    serde_json::from_value(v.clone()).map_err(|_| "tags 要是字符串数组")?;
                o.insert(k.clone(), json!(clean_tags(tags)));
            }
            "done" | "pinned" => {
                o.insert(
                    k.clone(),
                    json!(v
                        .as_bool()
                        .ok_or_else(|| format!("{k} 要是 true / false"))?),
                );
            }
            _ if v.is_null() => {
                o.remove(k);
            }
            _ => {
                o.insert(k.clone(), v.clone());
            }
        }
    }
    o.insert("updatedAt".into(), json!(now));
    Ok(())
}

/// 勾选完成时记下完成时间（统计用），取消完成时去掉
pub fn stamp_done(before: Option<&Value>, after: &mut Value, now: f64) {
    let was = before.map(|b| bool_of(b, "done")).unwrap_or(false);
    let is = bool_of(after, "done");
    if let Some(o) = after.as_object_mut() {
        if is && !was && !o.contains_key("doneAt") {
            o.insert("doneAt".into(), json!(now));
        } else if !is {
            o.remove("doneAt");
        } else if is && was {
            if let Some(d) = before.and_then(|b| b.get("doneAt")) {
                o.entry("doneAt").or_insert(d.clone());
            }
        }
    }
}

// ---------------------------------------------------------------- 筛选

#[derive(Deserialize, Debug, Clone, Default)]
pub struct Filter {
    /// 逗号分隔，如 todo,issue
    #[serde(rename = "type")]
    pub types: Option<String>,
    /// open（未完成）/ done（已完成）/ all（默认）
    pub status: Option<String>,
    pub tag: Option<String>,
    /// 逗号分隔，如 P0,P1；none 表示没设优先级
    pub priority: Option<String>,
    /// 关键词，搜标题和正文
    pub q: Option<String>,
    pub device: Option<String>,
    /// 分类路径（包括子分类）；none 表示未分类
    pub category: Option<String>,
    pub limit: Option<usize>,
    pub offset: Option<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Status {
    Open,
    Done,
    All,
}

fn split_list(s: &Option<String>) -> Vec<String> {
    s.as_deref()
        .unwrap_or("")
        .split(',')
        .map(|x| x.trim().to_string())
        .filter(|x| !x.is_empty())
        .collect()
}

impl Filter {
    pub fn type_list(&self) -> Vec<String> {
        split_list(&self.types)
    }
    pub fn priority_list(&self) -> Vec<String> {
        split_list(&self.priority)
            .into_iter()
            .map(|p| {
                if p.eq_ignore_ascii_case("none") {
                    "none".into()
                } else {
                    normalize_priority(&p).unwrap_or(p)
                }
            })
            .collect()
    }
    pub fn status(&self) -> Result<Status, String> {
        match self.status.as_deref().map(str::trim).unwrap_or("") {
            "" | "all" => Ok(Status::All),
            "open" => Ok(Status::Open),
            "done" => Ok(Status::Done),
            s => Err(format!("status 只能是 open / done / all，收到 {s}")),
        }
    }

    /// 除了关键词以外的条件（关键词由存储层用全文索引处理）
    pub fn matches(&self, item: &Value) -> bool {
        let types = self.type_list();
        if !types.is_empty() && !types.iter().any(|t| t == str_of(item, "type")) {
            return false;
        }
        match self.status().unwrap_or(Status::All) {
            Status::Open if bool_of(item, "done") => return false,
            Status::Done if !bool_of(item, "done") => return false,
            _ => {}
        }
        if let Some(tag) = self.tag.as_deref().filter(|t| !t.is_empty()) {
            let tag = tag.trim_start_matches('#');
            if !tags_of(item).iter().any(|t| t == tag) {
                return false;
            }
        }
        let ps = self.priority_list();
        if !ps.is_empty() {
            let p = str_of(item, "priority");
            let p = if p.is_empty() { "none" } else { p };
            if !ps.iter().any(|x| x == p) {
                return false;
            }
        }
        if let Some(d) = self.device.as_deref().filter(|d| !d.is_empty()) {
            if str_of(item, "device") != d {
                return false;
            }
        }
        if let Some(c) = self
            .category
            .as_deref()
            .map(str::trim)
            .filter(|c| !c.is_empty())
        {
            let ic = str_of(item, "category");
            if c == "none" {
                if !ic.is_empty() {
                    return false;
                }
            } else {
                let c = category::normalize_category(c)
                    .ok()
                    .flatten()
                    .unwrap_or_else(|| c.to_string());
                if !category::in_category(ic, &c) {
                    return false;
                }
            }
        }
        true
    }

    /// 关键词的简单匹配（不区分大小写的子串），存储层的兜底
    pub fn matches_text(&self, item: &Value) -> bool {
        match self.q.as_deref().map(str::trim).filter(|q| !q.is_empty()) {
            None => true,
            Some(q) => {
                let q = q.to_lowercase();
                str_of(item, "title").to_lowercase().contains(&q)
                    || str_of(item, "body").to_lowercase().contains(&q)
            }
        }
    }
}

/// 列表排序：置顶 → 优先级 → 手动排序 → 最近更新
pub fn sort_items(items: &mut [Value]) {
    items.sort_by(|a, b| {
        let key = |v: &Value| {
            let p = str_of(v, "priority");
            let p = PRIORITIES.iter().position(|x| *x == p).unwrap_or(9);
            let rank = v.get("rank").and_then(|x| x.as_f64()).unwrap_or(f64::MAX);
            (!bool_of(v, "pinned"), p, rank, -updated_at(v))
        };
        key(a)
            .partial_cmp(&key(b))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
}

// ---------------------------------------------------------------- 优先级整理

#[derive(Deserialize, Serialize, Debug, Clone, Default)]
pub struct PriorityChange {
    pub id: String,
    /// P0–P3；传 null 或 "" 表示清除
    #[serde(default, deserialize_with = "nullable")]
    pub priority: Option<Option<String>>,
    pub rank: Option<f64>,
    pub reason: Option<String>,
}

fn nullable<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Option<String>>, D::Error> {
    Ok(Some(Option::<String>::deserialize(d)?))
}

/// 一条调整前后的对比
#[derive(Serialize, Debug, Clone)]
pub struct PriorityDiff {
    pub id: String,
    pub title: String,
    pub from: Value,
    pub to: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// 把一组调整算到条目上，返回改后的条目和对比；不合法的调整直接报错（整批不生效）
pub fn plan_reprioritize(
    items: &BTreeMap<String, Value>,
    changes: &[PriorityChange],
    now: f64,
) -> Result<Vec<(Value, PriorityDiff)>, String> {
    let mut out = vec![];
    for c in changes {
        let cur = items
            .get(&c.id)
            .ok_or_else(|| format!("找不到条目 {}", c.id))?;
        let mut next = cur.clone();
        let mut patch = Map::new();
        if let Some(p) = &c.priority {
            match p.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                Some(p) => {
                    patch.insert(
                        "priority".into(),
                        json!(normalize_priority(p).ok_or_else(|| bad_priority(p))?),
                    );
                }
                None => {
                    patch.insert("priority".into(), Value::Null);
                }
            }
        }
        if let Some(r) = c.rank {
            patch.insert("rank".into(), json!(r));
        }
        if patch.is_empty() {
            return Err(format!("条目 {} 没有要改的内容（priority 或 rank）", c.id));
        }
        apply_patch(&mut next, &patch, now)?;
        let pick = |v: &Value| json!({ "priority": v.get("priority").cloned().unwrap_or(Value::Null), "rank": v.get("rank").cloned().unwrap_or(Value::Null) });
        let diff = PriorityDiff {
            id: c.id.clone(),
            title: str_of(cur, "title").to_string(),
            from: pick(cur),
            to: pick(&next),
            reason: c.reason.clone(),
        };
        out.push((next, diff));
    }
    Ok(out)
}

/// 本周一（本地时间）
pub fn week_start(d: NaiveDate) -> NaiveDate {
    d - chrono::Duration::days(d.weekday().num_days_from_monday() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn priority_words() {
        assert_eq!(normalize_priority("p1").as_deref(), Some("P1"));
        assert_eq!(normalize_priority("紧急").as_deref(), Some("P0"));
        assert_eq!(normalize_priority("low").as_deref(), Some("P3"));
        assert_eq!(normalize_priority("P9"), None);
    }

    #[test]
    fn new_item_defaults_and_validation() {
        let it = NewItem {
            title: "  写周报 ".into(),
            priority: Some("high".into()),
            due: Some(json!("2026-10-08")),
            tags: Some(vec!["#周报".into(), "周报".into()]),
            ..Default::default()
        }
        .into_item(1000.0, "claude")
        .unwrap();
        assert_eq!(it["type"], "todo");
        assert_eq!(it["title"], "写周报");
        assert_eq!(it["priority"], "P1");
        assert_eq!(it["due"], "2026-10-08");
        assert_eq!(it["tags"], json!(["周报"]));
        assert_eq!(it["createdBy"], "claude");
        assert_eq!(it["done"], false);
        assert!(NewItem {
            title: " ".into(),
            ..Default::default()
        }
        .into_item(0.0, "")
        .is_err());
        assert!(NewItem {
            title: "x".into(),
            kind: Some("bug".into()),
            ..Default::default()
        }
        .into_item(0.0, "")
        .is_err());
        assert!(NewItem {
            title: "x".into(),
            due: Some(json!("明天")),
            ..Default::default()
        }
        .into_item(0.0, "")
        .is_err());
        // 自定义字段保留，保留字段不能被覆盖
        let it: NewItem =
            serde_json::from_value(json!({"title":"x","source":"slack","done":true})).unwrap();
        let it = it.into_item(1.0, "").unwrap();
        assert_eq!(it["source"], "slack");
        assert_eq!(it["done"], false);
    }

    #[test]
    fn patch_rules() {
        let mut it =
            json!({"id":"a","type":"todo","title":"t","createdAt":1,"priority":"P2","x":1});
        let p: Map<String, Value> = serde_json::from_value(
            json!({"id":"b","createdAt":9,"priority":null,"x":null,"done":true,"due":"2026-01-02"}),
        )
        .unwrap();
        apply_patch(&mut it, &p, 50.0).unwrap();
        assert_eq!(it["id"], "a");
        assert_eq!(it["createdAt"], 1);
        assert!(it.get("priority").is_none());
        assert!(it.get("x").is_none());
        assert_eq!(it["done"], true);
        assert_eq!(it["updatedAt"], 50.0);
        let bad: Map<String, Value> = serde_json::from_value(json!({"title":""})).unwrap();
        assert!(apply_patch(&mut it, &bad, 1.0).is_err());
    }

    #[test]
    fn done_stamp() {
        let before = json!({"done":false});
        let mut after = json!({"done":true});
        stamp_done(Some(&before), &mut after, 7.0);
        assert_eq!(after["doneAt"], 7.0);
        let mut again = json!({"done":true});
        stamp_done(Some(&after), &mut again, 9.0);
        assert_eq!(again["doneAt"], 7.0);
        let mut undone = json!({"done":false,"doneAt":7});
        stamp_done(Some(&after), &mut undone, 9.0);
        assert!(undone.get("doneAt").is_none());
    }

    #[test]
    fn filter_and_sort() {
        let a =
            json!({"id":"a","type":"todo","title":"A","tags":["x"],"priority":"P2","updatedAt":1});
        let b = json!({"id":"b","type":"issue","title":"B","done":true,"updatedAt":2});
        let c = json!({"id":"c","type":"todo","title":"C","pinned":true,"updatedAt":0});
        let d = json!({"id":"d","type":"todo","title":"D","priority":"P0","updatedAt":0});
        let f = Filter {
            types: Some("todo".into()),
            status: Some("open".into()),
            ..Default::default()
        };
        assert!(f.matches(&a) && !f.matches(&b));
        let f = Filter {
            priority: Some("none".into()),
            ..Default::default()
        };
        assert!(!f.matches(&a) && f.matches(&b));
        let f = Filter {
            tag: Some("#x".into()),
            ..Default::default()
        };
        assert!(f.matches(&a) && !f.matches(&c));
        assert!(Filter {
            status: Some("bogus".into()),
            ..Default::default()
        }
        .status()
        .is_err());
        let mut v = vec![a, b, c, d];
        sort_items(&mut v);
        let ids: Vec<_> = v.iter().map(|x| x["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["c", "d", "a", "b"]);
    }

    #[test]
    fn reprioritize_plan() {
        let mut m = BTreeMap::new();
        m.insert(
            "a".to_string(),
            json!({"id":"a","title":"A","priority":"P3"}),
        );
        let ch: Vec<PriorityChange> =
            serde_json::from_value(json!([{"id":"a","priority":"P0","reason":"客户在催"}]))
                .unwrap();
        let plan = plan_reprioritize(&m, &ch, 5.0).unwrap();
        assert_eq!(plan[0].0["priority"], "P0");
        assert_eq!(plan[0].1.from["priority"], "P3");
        let clear: Vec<PriorityChange> =
            serde_json::from_value(json!([{"id":"a","priority":null}])).unwrap();
        assert!(plan_reprioritize(&m, &clear, 5.0).unwrap()[0]
            .0
            .get("priority")
            .is_none());
        let missing: Vec<PriorityChange> =
            serde_json::from_value(json!([{"id":"zz","priority":"P1"}])).unwrap();
        assert!(plan_reprioritize(&m, &missing, 5.0).is_err());
        let empty: Vec<PriorityChange> = serde_json::from_value(json!([{"id":"a"}])).unwrap();
        assert!(plan_reprioritize(&m, &empty, 5.0).is_err());
    }

    #[test]
    fn ids_are_unique_enough() {
        let a = new_id();
        let b = new_id();
        assert_ne!(a, b);
        assert!(a.chars().all(|c| c.is_ascii_alphanumeric()));
    }
}
