//! 分类和标签的管理：列表（带数量）、新建空分类、改名 / 移动、删除，标签改名 / 合并 / 删除。
//! 改动会同步到条目上（不改 updatedAt，免得所有条目都显示“刚刚”）。

use crate::{invalid, log, read_row, write_row, Result, Store, StoreError};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use xp_core::category::{
    in_category, normalize_category, normalize_tag, parent_of, rename_path, with_ancestors,
};
use xp_core::{bool_of, now_ms, str_of, tags_of};

fn norm(path: &str) -> Result<String> {
    normalize_category(path)
        .map_err(invalid)?
        .ok_or_else(|| invalid("分类不能为空"))
}

/// 所有未删除条目
fn live_items(conn: &Connection) -> Result<Vec<Value>> {
    let mut q = conn.prepare("SELECT data FROM items WHERE deleted_at IS NULL")?;
    let rows = q.query_map([], |r| r.get::<_, String>(0))?;
    let mut out = vec![];
    for s in rows {
        if let Ok(v) = serde_json::from_str::<Value>(&s?) {
            out.push(v);
        }
    }
    Ok(out)
}

fn explicit(conn: &Connection) -> Result<Vec<String>> {
    let mut q = conn.prepare("SELECT path FROM categories ORDER BY path")?;
    let rows = q.query_map([], |r| r.get::<_, String>(0))?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

/// 对每条（未删除的）条目执行 f；f 返回改后的条目就写回。返回改了几条
fn rewrite_items(tx: &Connection, mut f: impl FnMut(&Value) -> Option<Value>) -> Result<usize> {
    let mut n = 0;
    for it in live_items(tx)? {
        if let Some(next) = f(&it) {
            let id = xp_core::id_of(&next).ok_or_else(|| invalid("条目缺少 id"))?;
            let deleted = read_row(tx, &id)?.and_then(|r| r.deleted_at);
            write_row(tx, &next, deleted)?;
            n += 1;
        }
    }
    Ok(n)
}

fn set_category(it: &Value, cat: Option<&str>) -> Value {
    let mut v = it.clone();
    if let Some(o) = v.as_object_mut() {
        match cat {
            Some(c) => {
                o.insert("category".into(), json!(c));
            }
            None => {
                o.remove("category");
            }
        }
    }
    v
}

impl Store {
    /// 手工建的分类路径（空分类也在），界面据此和条目上的分类一起画出分类树
    pub fn category_paths(&self) -> Result<Vec<String>> {
        explicit(&self.lock())
    }

    /// 分类列表：路径、层级、本分类条目数、含子分类的总数和未完成数
    pub fn list_categories(&self) -> Result<Vec<Value>> {
        let conn = self.lock();
        let items = live_items(&conn)?;
        let mut paths: BTreeMap<String, bool> = BTreeMap::new();
        for p in explicit(&conn)? {
            for a in with_ancestors(&p) {
                paths.entry(a).or_insert(false);
            }
            paths.insert(p, true);
        }
        for it in &items {
            let c = str_of(it, "category");
            if !c.is_empty() {
                for a in with_ancestors(c) {
                    paths.entry(a).or_insert(false);
                }
            }
        }
        Ok(paths
            .into_iter()
            .map(|(p, exp)| {
                let direct = items.iter().filter(|i| str_of(i, "category") == p).count();
                let under: Vec<&Value> = items
                    .iter()
                    .filter(|i| in_category(str_of(i, "category"), &p))
                    .collect();
                let open = under.iter().filter(|i| !bool_of(i, "done")).count();
                json!({
                    "path": p,
                    "name": p.rsplit('/').next().unwrap_or(&p),
                    "depth": p.matches('/').count(),
                    "direct": direct,
                    "total": under.len(),
                    "open": open,
                    "explicit": exp,
                })
            })
            .collect())
    }

    /// 先建一个空分类
    pub fn create_category(&self, path: &str, actor: &str) -> Result<String> {
        let p = norm(path)?;
        self.write(|tx| {
            let n = tx.execute(
                "INSERT OR IGNORE INTO categories(path, created_at) VALUES (?1, ?2)",
                params![p, now_ms()],
            )?;
            if n == 0 {
                return Err(invalid(format!("分类 {p} 已经有了")));
            }
            log(tx, actor, "create-category", "", None, None, Some(&p))
        })?;
        Ok(p)
    }

    /// 改名或移动分类（子分类一起）；目标已存在就合并进去。返回改了几条条目
    pub fn rename_category(&self, from: &str, to: &str, actor: &str) -> Result<usize> {
        let (from, to) = (norm(from)?, norm(to)?);
        if from == to {
            return Ok(0);
        }
        if in_category(&to, &from) {
            return Err(invalid("不能把分类移到它自己的子分类下面"));
        }
        if to.matches('/').count() + 1 > xp_core::category::MAX_DEPTH {
            return Err(invalid("分类最多 5 层"));
        }
        let (n, _) = self.write(|tx| {
            let mut exists = explicit(tx)?.iter().any(|p| in_category(p, &from));
            let n = rewrite_items(tx, |it| {
                let c = str_of(it, "category");
                rename_path(c, &from, &to).map(|nc| set_category(it, Some(&nc)))
            })?;
            exists |= n > 0;
            if !exists {
                return Err(StoreError::NotFound(format!("没有分类 {from}")));
            }
            for p in explicit(tx)? {
                if let Some(np) = rename_path(&p, &from, &to) {
                    tx.execute("DELETE FROM categories WHERE path = ?1", [&p])?;
                    tx.execute(
                        "INSERT OR IGNORE INTO categories(path, created_at) VALUES (?1, ?2)",
                        params![np, now_ms()],
                    )?;
                }
            }
            log(
                tx,
                actor,
                "rename-category",
                "",
                None,
                None,
                Some(&format!("{from} → {to}，条目 {n} 条")),
            )?;
            Ok(n)
        })?;
        Ok(n)
    }

    /// 删除分类（和它的子分类）。to_parent=true 时里面的条目移到上一级，否则变成未分类。返回改了几条
    pub fn delete_category(&self, path: &str, to_parent: bool, actor: &str) -> Result<usize> {
        let p = norm(path)?;
        let dest = if to_parent {
            parent_of(&p).map(String::from)
        } else {
            None
        };
        let (n, _) = self.write(|tx| {
            let n = rewrite_items(tx, |it| {
                in_category(str_of(it, "category"), &p).then(|| set_category(it, dest.as_deref()))
            })?;
            for e in explicit(tx)? {
                if in_category(&e, &p) {
                    tx.execute("DELETE FROM categories WHERE path = ?1", [&e])?;
                }
            }
            log(
                tx,
                actor,
                "delete-category",
                "",
                None,
                None,
                Some(&format!(
                    "{p}，条目 {n} 条 → {}",
                    dest.as_deref().unwrap_or("未分类")
                )),
            )?;
            Ok(n)
        })?;
        Ok(n)
    }

    /// 标签列表（按使用次数从多到少）
    pub fn list_tags(&self) -> Result<Vec<Value>> {
        let items = live_items(&self.lock())?;
        let mut m: BTreeMap<String, (usize, usize)> = BTreeMap::new();
        for it in &items {
            for t in tags_of(it) {
                let e = m.entry(t).or_default();
                e.0 += 1;
                if !bool_of(it, "done") {
                    e.1 += 1;
                }
            }
        }
        let mut v: Vec<(String, (usize, usize))> = m.into_iter().collect();
        v.sort_by(|a, b| b.1 .0.cmp(&a.1 .0).then(a.0.cmp(&b.0)));
        Ok(v.into_iter()
            .map(|(t, (n, o))| json!({"tag": t, "total": n, "open": o}))
            .collect())
    }

    /// 标签改名；新名字已经在用就等于合并。返回改了几条
    pub fn rename_tag(&self, from: &str, to: &str, actor: &str) -> Result<usize> {
        let (from, to) = (
            normalize_tag(from).map_err(invalid)?,
            normalize_tag(to).map_err(invalid)?,
        );
        if from == to {
            return Ok(0);
        }
        let (n, _) = self.write(|tx| {
            let n = rewrite_items(tx, |it| {
                let tags = tags_of(it);
                if !tags.contains(&from) {
                    return None;
                }
                let mut out: Vec<String> = vec![];
                for t in tags {
                    let t = if t == from { to.clone() } else { t };
                    if !out.contains(&t) {
                        out.push(t);
                    }
                }
                let mut v = it.clone();
                v["tags"] = json!(out);
                Some(v)
            })?;
            if n == 0 {
                return Err(StoreError::NotFound(format!("没有条目用标签 {from}")));
            }
            log(
                tx,
                actor,
                "rename-tag",
                "",
                None,
                None,
                Some(&format!("#{from} → #{to}，条目 {n} 条")),
            )?;
            Ok(n)
        })?;
        Ok(n)
    }

    /// 从所有条目上去掉这个标签。返回改了几条
    pub fn delete_tag(&self, tag: &str, actor: &str) -> Result<usize> {
        let tag = normalize_tag(tag).map_err(invalid)?;
        let (n, _) = self.write(|tx| {
            let n = rewrite_items(tx, |it| {
                let tags = tags_of(it);
                if !tags.contains(&tag) {
                    return None;
                }
                let mut v = it.clone();
                v["tags"] = json!(tags.into_iter().filter(|t| *t != tag).collect::<Vec<_>>());
                Some(v)
            })?;
            log(
                tx,
                actor,
                "delete-tag",
                "",
                None,
                None,
                Some(&format!("#{tag}，条目 {n} 条")),
            )?;
            Ok(n)
        })?;
        Ok(n)
    }
}
