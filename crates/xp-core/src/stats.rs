//! 统计：给外部 AI 做分析用的现成数字。分析本身由 AI 做，这里只负责算准。

use crate::{
    bool_of, is_checkable, local_date_of, num_of, str_of, tags_of, updated_at, week_start,
    PRIORITIES,
};
use chrono::NaiveDate;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

/// 多少天没动算“长期未动”
pub const STALE_DAYS: i64 = 30;
const WEEKS: i64 = 8;

pub fn stats(items: &[Value], today: NaiveDate) -> Value {
    let open = |v: &&Value| !bool_of(v, "done");
    let total = items.len();
    let done = items.iter().filter(|v| bool_of(v, "done")).count();

    let mut by_type: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    for it in items {
        let e = by_type.entry(str_of(it, "type").to_string()).or_default();
        if bool_of(it, "done") {
            e.1 += 1
        } else {
            e.0 += 1
        }
    }
    let by_type: Map<String, Value> = by_type
        .into_iter()
        .map(|(k, (o, d))| (k, json!({"open": o, "done": d})))
        .collect();

    // 优先级只统计可勾选且未完成的条目
    let actionable: Vec<&Value> = items
        .iter()
        .filter(|v| is_checkable(str_of(v, "type")))
        .filter(open)
        .collect();
    let mut by_priority = Map::new();
    for p in PRIORITIES.iter().chain(std::iter::once(&"none")) {
        let n = actionable
            .iter()
            .filter(|v| {
                let x = str_of(v, "priority");
                if *p == "none" {
                    x.is_empty()
                } else {
                    x == *p
                }
            })
            .count();
        by_priority.insert(p.to_string(), json!(n));
    }

    let mut tags: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    for it in items {
        for t in tags_of(it) {
            let e = tags.entry(t).or_default();
            e.1 += 1;
            if !bool_of(it, "done") {
                e.0 += 1
            }
        }
    }
    let mut tags: Vec<(String, (usize, usize))> = tags.into_iter().collect();
    tags.sort_by(|a, b| b.1 .1.cmp(&a.1 .1).then(a.0.cmp(&b.0)));
    let by_tag: Vec<Value> = tags
        .into_iter()
        .take(20)
        .map(|(t, (o, n))| json!({"tag": t, "open": o, "total": n}))
        .collect();

    // 按分类（完整路径；未分类单独算）
    let mut cats: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    for it in items {
        let c = str_of(it, "category");
        let e = cats
            .entry(if c.is_empty() {
                "（未分类）".into()
            } else {
                c.to_string()
            })
            .or_default();
        e.1 += 1;
        if !bool_of(it, "done") {
            e.0 += 1;
        }
    }
    let by_category: Vec<Value> = cats
        .into_iter()
        .map(|(c, (o, n))| json!({"category": c, "open": o, "total": n}))
        .collect();

    let mut by_device: BTreeMap<String, usize> = BTreeMap::new();
    for it in items.iter().filter(open) {
        let d = str_of(it, "device");
        *by_device
            .entry(if d.is_empty() {
                "（未指定）".into()
            } else {
                d.to_string()
            })
            .or_default() += 1;
    }

    let today_s = today.format("%Y-%m-%d").to_string();
    let mut overdue: Vec<Value> = actionable
        .iter()
        .filter(|v| { let d = str_of(v, "due"); !d.is_empty() && d < today_s.as_str() })
        .map(|v| json!({"id": str_of(v, "id"), "title": str_of(v, "title"), "due": str_of(v, "due"), "priority": v.get("priority")}))
        .collect();
    overdue.sort_by(|a, b| a["due"].as_str().cmp(&b["due"].as_str()));

    let mut stale: Vec<(i64, &Value)> = actionable
        .iter()
        .filter_map(|v| local_date_of(updated_at(v)).map(|d| ((today - d).num_days(), *v)))
        .filter(|(days, _)| *days >= STALE_DAYS)
        .collect();
    stale.sort_by_key(|x| std::cmp::Reverse(x.0));
    let stale_count = stale.len();
    let stale_top: Vec<Value> = stale
        .into_iter()
        .take(10)
        .map(|(d, v)| json!({"id": str_of(v, "id"), "title": str_of(v, "title"), "days": d}))
        .collect();

    // 最近几周新建 / 完成数量（完成时间优先用 doneAt，老数据退回用 updatedAt）
    let this_week = week_start(today);
    let mut weekly = vec![];
    for i in (0..WEEKS).rev() {
        let start = this_week - chrono::Duration::weeks(i);
        let end = start + chrono::Duration::weeks(1);
        let in_week = |ms: f64| {
            local_date_of(ms)
                .map(|d| d >= start && d < end)
                .unwrap_or(false)
        };
        let created = items
            .iter()
            .filter(|v| in_week(num_of(v, "createdAt")))
            .count();
        let completed = items
            .iter()
            .filter(|v| bool_of(v, "done"))
            .filter(|v| {
                in_week(
                    v.get("doneAt")
                        .and_then(|x| x.as_f64())
                        .unwrap_or_else(|| updated_at(v)),
                )
            })
            .count();
        weekly.push(
            json!({"weekStart": start.to_string(), "created": created, "completed": completed}),
        );
    }

    json!({
        "today": today_s,
        "total": total,
        "open": total - done,
        "done": done,
        "pinned": items.iter().filter(|v| bool_of(v, "pinned")).filter(open).count(),
        "byType": by_type,
        "openByPriority": by_priority,
        "byTag": by_tag,
        "byCategory": by_category,
        "openByDevice": by_device,
        "overdue": overdue,
        "stale": {"days": STALE_DAYS, "count": stale_count, "oldest": stale_top},
        "weekly": weekly,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Local, TimeZone};

    fn ms(y: i32, m: u32, d: u32) -> f64 {
        Local
            .with_ymd_and_hms(y, m, d, 12, 0, 0)
            .unwrap()
            .timestamp_millis() as f64
    }

    #[test]
    fn numbers_add_up() {
        let today = NaiveDate::from_ymd_opt(2026, 9, 29).unwrap();
        let items = vec![
            json!({"id":"a","type":"todo","title":"逾期","due":"2026-09-01","priority":"P0","tags":["x"],"createdAt":ms(2026,9,28),"updatedAt":ms(2026,9,28)}),
            json!({"id":"b","type":"todo","title":"老的","createdAt":ms(2026,7,1),"updatedAt":ms(2026,7,1),"device":"BASE"}),
            json!({"id":"c","type":"issue","title":"完成","done":true,"doneAt":ms(2026,9,29),"tags":["x"],"createdAt":ms(2026,9,20),"updatedAt":ms(2026,9,29)}),
            json!({"id":"d","type":"note","title":"笔记","createdAt":ms(2026,9,29),"updatedAt":ms(2026,9,29)}),
        ];
        let s = stats(&items, today);
        assert_eq!(s["total"], 4);
        assert_eq!(s["done"], 1);
        assert_eq!(s["byType"]["todo"]["open"], 2);
        assert_eq!(s["openByPriority"]["P0"], 1);
        assert_eq!(s["openByPriority"]["none"], 1); // 笔记不算
        assert_eq!(s["byTag"][0]["tag"], "x");
        assert_eq!(s["byTag"][0]["total"], 2);
        assert_eq!(s["overdue"][0]["id"], "a");
        assert_eq!(s["stale"]["count"], 1);
        assert_eq!(s["openByDevice"]["BASE"], 1);
        let w = s["weekly"].as_array().unwrap();
        assert_eq!(w.len(), 8);
        assert_eq!(w[7]["weekStart"], "2026-09-28");
        assert_eq!(w[7]["created"], 2);
        assert_eq!(w[7]["completed"], 1);
    }
}
