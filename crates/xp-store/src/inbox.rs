//! 收件箱里导入的聊天记录（目前是微信「合并转发 → 导出」的 ZIP）。
//!
//! - 附件按内容存进 assets/（`wx-<内容哈希>.<扩展名>`），同一张图导入几次都只存一份。
//! - 消息按「发送人 + 时间 + 正文（附件换成内容哈希）+ 同样内容的第几条」算指纹，
//!   同一个聊天里指纹相同就算重复，所以同一个群多次导出、时间有重叠也不会多出来。
//! - 删掉的消息指纹还在，再导入不会复活。

use crate::{invalid, log, Result, Store, StoreError};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::io::{Cursor, Read};
use xp_core::wechat::{self, Record};
use xp_core::{new_id, now_ms, str_of};

pub const SOURCE_WECHAT: &str = "wechat";
const MAX_ENTRIES: usize = 5000;
const MAX_TOTAL: u64 = 1 << 30;
const MAX_TXT: u64 = 16 << 20;
const MAX_CHAT_NAME: usize = 60;

/// 解析好、还没写入的一份导出
struct Prepared {
    records: Vec<Record>,
    /// 每条消息的附件和指纹
    messages: Vec<(Value, String)>,
    /// 要存进 assets/ 的文件：(资源名, 内容)
    files: Vec<(String, Vec<u8>)>,
    /// 正文里没提到的文件
    extra: Vec<Value>,
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn asset_name_for(hash: &str, file: &str) -> String {
    let ext: String = file
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .filter(|e| !e.is_empty() && e.len() <= 8 && e.chars().all(|c| c.is_ascii_alphanumeric()))
        .unwrap_or_else(|| "bin".into());
    format!("wx-{}.{ext}", &hash[..24])
}

fn base_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn prepare(zip_bytes: &[u8]) -> Result<Prepared> {
    let bad = |m: &str| invalid(format!("这个文件不是能认出来的微信聊天记录导出：{m}"));
    let mut zip = zip::ZipArchive::new(Cursor::new(zip_bytes)).map_err(|_| bad("不是 ZIP 文件"))?;
    if zip.len() > MAX_ENTRIES {
        return Err(bad("文件太多"));
    }
    // 先读所有文件（有总大小上限，防止解压炸弹）
    let mut entries: Vec<(String, Vec<u8>)> = vec![];
    let mut total = 0u64;
    for i in 0..zip.len() {
        let mut f = zip.by_index(i).map_err(|_| bad("ZIP 已损坏"))?;
        if f.is_dir() {
            continue;
        }
        if f.encrypted() {
            return Err(bad("ZIP 有密码"));
        }
        let name = f.name().replace('\\', "/");
        let mut buf = vec![];
        let left = MAX_TOTAL.saturating_sub(total);
        (&mut f)
            .take(left + 1)
            .read_to_end(&mut buf)
            .map_err(|_| bad("ZIP 已损坏"))?;
        total += buf.len() as u64;
        if total > MAX_TOTAL {
            return Err(invalid("导出文件太大（解压后超过 1GB），请分几次导出"));
        }
        entries.push((name, buf));
    }
    // 聊天记录正文：优先 聊天记录.txt，否则挑能解析出最多消息的 txt
    let mut best: Option<(usize, Vec<Record>)> = None;
    for (i, (name, data)) in entries.iter().enumerate() {
        if !name.to_lowercase().ends_with(".txt") || data.len() as u64 > MAX_TXT {
            continue;
        }
        let Ok(text) = std::str::from_utf8(data) else {
            continue;
        };
        let Some(recs) = wechat::parse_transcript(text) else {
            continue;
        };
        let native = base_name(name) == "聊天记录.txt";
        let better = match &best {
            None => true,
            Some((j, r)) => {
                native && base_name(&entries[*j].0) != "聊天记录.txt" || recs.len() > r.len()
            }
        };
        if better {
            best = Some((i, recs));
        }
    }
    let Some((ti, records)) = best else {
        return Err(bad("找不到聊天记录.txt，或者格式认不出来"));
    };
    if records.is_empty() {
        return Err(bad("里面没有消息"));
    }
    // 附件：按文件名找（正文里只写文件名），同名的有歧义就不关联
    let mut hashes: Vec<Option<String>> = vec![None; entries.len()];
    for (i, (_, data)) in entries.iter().enumerate() {
        if i != ti {
            hashes[i] = Some(hex(&Sha256::digest(data)));
        }
    }
    let by_name = |n: &str| -> Option<usize> {
        let mut hit = entries
            .iter()
            .enumerate()
            .filter(|(i, (p, _))| *i != ti && base_name(p) == n);
        let first = hit.next()?.0;
        hit.next().is_none().then_some(first)
    };
    let mut used = vec![false; entries.len()];
    let mut seen: std::collections::HashMap<(String, String, String), usize> = Default::default();
    let mut messages = vec![];
    for r in &records {
        let mut atts = vec![];
        for line in r.text.split('\n') {
            let Some((kind, name)) = wechat::attachment_ref(line) else {
                continue;
            };
            match by_name(name) {
                Some(i) => {
                    used[i] = true;
                    let h = hashes[i].clone().unwrap_or_default();
                    atts.push(json!({"kind": kind, "name": name, "asset": asset_name_for(&h, name), "size": entries[i].1.len()}));
                }
                None => atts.push(json!({"kind": kind, "name": name, "missing": true})),
            }
        }
        let norm = wechat::normalized_text(&r.text, |n| {
            by_name(n)
                .and_then(|i| hashes[i].as_ref())
                .map(|h| format!("sha:{}", &h[..24]))
        });
        let key = (r.sender.clone(), r.time.clone(), norm.clone());
        let k = seen.entry(key).or_insert(0);
        let fp = hex(&Sha256::digest(
            format!("{}\u{1f}{}\u{1f}{}\u{1f}{}", r.sender, r.time, norm, k).as_bytes(),
        ))[..32]
            .to_string();
        *k += 1;
        messages.push((Value::Array(atts), fp));
    }
    let mut files = vec![];
    let mut extra = vec![];
    for (i, (name, data)) in entries.into_iter().enumerate() {
        let Some(h) = &hashes[i] else { continue };
        let asset = asset_name_for(h, &name);
        if !used[i] {
            extra.push(json!({"kind": wechat::kind_of_name(&name), "name": name, "asset": asset, "size": data.len()}));
        }
        if !files.iter().any(|(a, _): &(String, Vec<u8>)| a == &asset) {
            files.push((asset, data));
        }
    }
    Ok(Prepared {
        records,
        messages,
        files,
        extra,
    })
}

fn normalize_chat_name(s: &str) -> Result<String> {
    let s: String = s
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .filter(|c| !c.is_control())
        .collect();
    if s.is_empty() {
        return Err(invalid("聊天名不能为空"));
    }
    if s.chars().count() > MAX_CHAT_NAME {
        return Err(invalid(format!("聊天名太长（最多 {MAX_CHAT_NAME} 个字）")));
    }
    Ok(s)
}

fn read_chat(conn: &Connection, id: &str) -> Result<Value> {
    let s: Option<String> = conn
        .query_row(
            "SELECT data FROM chats WHERE id = ?1 AND deleted_at IS NULL",
            [id],
            |r| r.get(0),
        )
        .optional()?;
    s.and_then(|s| serde_json::from_str(&s).ok())
        .ok_or_else(|| StoreError::NotFound(format!("找不到聊天 {id}")))
}

fn chat_by_name(conn: &Connection, source: &str, name: &str) -> Result<Option<Value>> {
    let s: Option<String> = conn
        .query_row(
            "SELECT data FROM chats WHERE source = ?1 AND name = ?2 AND deleted_at IS NULL",
            params![source, name],
            |r| r.get(0),
        )
        .optional()?;
    Ok(s.and_then(|s| serde_json::from_str(&s).ok()))
}

fn write_chat(conn: &Connection, c: &Value, deleted_at: Option<f64>) -> Result<()> {
    conn.execute(
        "INSERT INTO chats (id, source, name, created_at, updated_at, deleted_at, data) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(id) DO UPDATE SET source = excluded.source, name = excluded.name, updated_at = excluded.updated_at,
           deleted_at = excluded.deleted_at, data = excluded.data",
        params![
            str_of(c, "id"),
            str_of(c, "source"),
            str_of(c, "name"),
            c.get("createdAt").and_then(|x| x.as_f64()).unwrap_or(0.0),
            c.get("updatedAt").and_then(|x| x.as_f64()).unwrap_or(0.0),
            deleted_at,
            c.to_string()
        ],
    )?;
    Ok(())
}

fn message_of(r: &rusqlite::Row) -> rusqlite::Result<Value> {
    let atts: String = r.get(7)?;
    Ok(json!({
        "id": r.get::<_, String>(0)?,
        "chatId": r.get::<_, String>(1)?,
        "bundleId": r.get::<_, String>(2)?,
        "seq": r.get::<_, i64>(3)?,
        "time": r.get::<_, String>(4)?,
        "sender": r.get::<_, String>(5)?,
        "text": r.get::<_, String>(6)?,
        "attachments": serde_json::from_str::<Value>(&atts).unwrap_or(json!([])),
    }))
}

const MSG_COLS: &str = "id, chat_id, bundle_id, seq, time, sender, text, attachments";

/// 查消息的条件
#[derive(Debug, Default, Clone)]
pub struct MessageQuery {
    pub chat: Option<String>,
    pub q: Option<String>,
    pub from: Option<String>,
    pub to: Option<String>,
    pub ids: Option<Vec<String>>,
    /// 只要「已处理到」之后的
    pub unread: bool,
    /// 从最新的往前数：跳过几条、最多几条（结果仍按时间从早到晚）
    pub offset: usize,
    pub limit: Option<usize>,
}

impl Store {
    /// 先看看这份导出：多少条、时间范围、谁在说话、像是哪个已有的聊天、有多少条已经导入过
    pub fn wechat_preview(&self, zip: &[u8]) -> Result<Value> {
        let p = prepare(zip)?;
        let me = self.inbox_me()?;
        let conn = self.lock();
        let mut senders: Vec<(String, usize)> = vec![];
        for r in &p.records {
            match senders.iter_mut().find(|s| s.0 == r.sender) {
                Some(s) => s.1 += 1,
                None => senders.push((r.sender.clone(), 1)),
            }
        }
        senders.sort_by_key(|s| std::cmp::Reverse(s.1));
        // 最像的已有聊天：已有指纹重合最多的，其次是发送人重合最多的
        let fps: Vec<&str> = p.messages.iter().map(|m| m.1.as_str()).collect();
        let mut best: Option<(String, usize, usize)> = None;
        let mut q = conn.prepare(
            "SELECT c.id, c.name FROM chats c WHERE c.source = ?1 AND c.deleted_at IS NULL",
        )?;
        let chats: Vec<(String, String)> = q
            .query_map([SOURCE_WECHAT], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        for (id, name) in chats {
            let mut dup = 0usize;
            for f in &fps {
                let hit: Option<i64> = conn
                    .query_row(
                        "SELECT 1 FROM messages WHERE chat_id = ?1 AND fp = ?2",
                        params![id, f],
                        |r| r.get(0),
                    )
                    .optional()?;
                dup += hit.is_some() as usize;
            }
            let mut people = 0usize;
            for (s, _) in &senders {
                if me.contains(s) {
                    continue;
                }
                let hit: Option<i64> = conn
                    .query_row(
                        "SELECT 1 FROM messages WHERE chat_id = ?1 AND sender = ?2 LIMIT 1",
                        params![id, s],
                        |r| r.get(0),
                    )
                    .optional()?;
                people += hit.is_some() as usize;
            }
            if dup + people > 0 && best.as_ref().is_none_or(|b| (dup, people) > (b.1, b.2)) {
                best = Some((name, dup, people));
            }
        }
        let first = p.records.iter().map(|r| &r.time).min();
        let last = p.records.iter().map(|r| &r.time).max();
        Ok(json!({
            "source": SOURCE_WECHAT,
            "count": p.records.len(),
            "start": first,
            "end": last,
            "senders": senders.iter().map(|(n, c)| json!({"name": n, "count": c})).collect::<Vec<_>>(),
            "files": p.files.len(),
            "missing": p.messages.iter().flat_map(|m| m.0.as_array().cloned().unwrap_or_default())
                .filter(|a| a.get("missing").is_some()).count(),
            "suggestedChat": best.as_ref().map(|b| b.0.clone())
                .unwrap_or_else(|| wechat::suggest_chat_name(&p.records, &me)),
            "matchedChat": best.as_ref().map(|b| json!({"name": b.0, "duplicates": b.1})),
        }))
    }

    /// 导入一份微信导出到名为 `chat` 的聊天（没有就新建）
    pub fn wechat_import(
        &self,
        zip: &[u8],
        file_name: &str,
        chat: &str,
        actor: &str,
    ) -> Result<Value> {
        let chat_name = normalize_chat_name(chat)?;
        let p = prepare(zip)?;
        // 附件先落盘（和数据库写入分开，避免拿着锁写大文件）
        for (asset, data) in &p.files {
            if self.dir.join("assets").join(asset).is_file() {
                continue;
            }
            self.put_asset(asset, data)?;
        }
        let now = now_ms();
        let total = p.records.len();
        let file_name: String = base_name(&file_name.replace('\\', "/"))
            .chars()
            .take(200)
            .collect();
        let (out, _) = self.write(|tx| {
            let chat = match chat_by_name(tx, SOURCE_WECHAT, &chat_name)? {
                Some(mut c) => {
                    c["updatedAt"] = json!(now);
                    c
                }
                None => json!({"id": new_id(), "source": SOURCE_WECHAT, "name": chat_name, "createdAt": now, "updatedAt": now}),
            };
            write_chat(tx, &chat, None)?;
            let chat_id = str_of(&chat, "id").to_string();
            let bundle_id = new_id();
            let mut added = 0usize;
            for (seq, (r, (atts, fp))) in p.records.iter().zip(&p.messages).enumerate() {
                let id = new_id();
                let n = tx.execute(
                    "INSERT OR IGNORE INTO messages (id, chat_id, bundle_id, bundle_at, seq, time, sender, text, attachments, fp)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                    params![id, chat_id, bundle_id, now, seq as i64, r.time, r.sender, r.text, atts.to_string(), fp],
                )?;
                if n == 1 {
                    tx.execute(
                        "INSERT INTO messages_fts (id, sender, text) VALUES (?1, ?2, ?3)",
                        params![id, r.sender, r.text],
                    )?;
                    added += 1;
                }
            }
            let bundle = json!({
                "id": bundle_id, "chatId": chat_id, "source": SOURCE_WECHAT, "fileName": file_name,
                "importedAt": now, "importedBy": actor,
                "start": p.records.iter().map(|r| &r.time).min(), "end": p.records.iter().map(|r| &r.time).max(),
                "total": total, "added": added, "files": p.extra,
            });
            tx.execute(
                "INSERT INTO bundles (id, chat_id, imported_at, data) VALUES (?1, ?2, ?3, ?4)",
                params![bundle_id, chat_id, now, bundle.to_string()],
            )?;
            log(
                tx,
                actor,
                "import",
                "",
                None,
                None,
                Some(&format!("微信聊天「{chat_name}」：{total} 条，新增 {added} 条")),
            )?;
            Ok(json!({"chat": chat, "bundle": bundle, "total": total, "added": added, "duplicates": total - added}))
        })?;
        Ok(out)
    }

    pub fn list_chats(&self) -> Result<Vec<Value>> {
        let conn = self.lock();
        let mut q = conn.prepare(
            "SELECT c.data,
               (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id AND m.deleted_at IS NULL),
               (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id AND m.deleted_at IS NULL
                  AND m.time > COALESCE(json_extract(c.data, '$.readUpTo'), '')),
               (SELECT json_object('time', m.time, 'sender', m.sender, 'text', substr(m.text, 1, 80))
                  FROM messages m WHERE m.chat_id = c.id AND m.deleted_at IS NULL
                  ORDER BY m.time DESC, m.bundle_at DESC, m.seq DESC LIMIT 1)
             FROM chats c WHERE c.deleted_at IS NULL",
        )?;
        let rows = q.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, Option<String>>(3)?,
            ))
        })?;
        let mut out = vec![];
        for row in rows {
            let (d, count, unread, last) = row?;
            let Ok(mut c) = serde_json::from_str::<Value>(&d) else {
                continue;
            };
            c["count"] = json!(count);
            c["unread"] = json!(unread);
            c["last"] = last
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or(Value::Null);
            out.push(c);
        }
        out.sort_by(|a, b| {
            let t = |v: &Value| v["last"]["time"].as_str().unwrap_or("").to_string();
            t(b).cmp(&t(a))
        });
        Ok(out)
    }

    pub fn get_chat(&self, id: &str) -> Result<Value> {
        read_chat(&self.lock(), id)
    }

    /// 改聊天：name（改成已有的名字就合并过去）、readUpTo（已处理到的时间，null 清掉）、note
    pub fn update_chat(&self, id: &str, patch: &Map<String, Value>, actor: &str) -> Result<Value> {
        let now = now_ms();
        let (out, _) = self.write(|tx| {
            let mut c = read_chat(tx, id)?;
            for (k, v) in patch {
                match k.as_str() {
                    "name" => {
                        let name = normalize_chat_name(v.as_str().unwrap_or(""))?;
                        if name == str_of(&c, "name") {
                            continue;
                        }
                        if let Some(target) = chat_by_name(tx, str_of(&c, "source"), &name)? {
                            // 合并：消息挪过去（重复的丢掉），导入记录也挪过去，这个聊天删掉
                            let tid = str_of(&target, "id").to_string();
                            tx.execute(
                                "UPDATE OR IGNORE messages SET chat_id = ?1 WHERE chat_id = ?2",
                                params![tid, id],
                            )?;
                            tx.execute(
                                "DELETE FROM messages_fts WHERE id IN (SELECT id FROM messages WHERE chat_id = ?1)",
                                [id],
                            )?;
                            tx.execute("DELETE FROM messages WHERE chat_id = ?1", [id])?;
                            tx.execute(
                                "UPDATE bundles SET chat_id = ?1 WHERE chat_id = ?2",
                                params![tid, id],
                            )?;
                            c["updatedAt"] = json!(now);
                            write_chat(tx, &c, Some(now))?;
                            log(tx, actor, "chat.merge", "", None, None,
                                Some(&format!("聊天「{}」并入「{name}」", str_of(&c, "name"))))?;
                            return Ok(target);
                        }
                        c["name"] = json!(name);
                    }
                    "readUpTo" => match v {
                        Value::Null => {
                            c.as_object_mut().map(|o| o.remove("readUpTo"));
                        }
                        Value::String(s) if s.len() <= 32 => c["readUpTo"] = json!(s),
                        _ => return Err(invalid("readUpTo 应该是时间，比如 2026-09-29 16:03")),
                    },
                    "note" => c["note"] = json!(v.as_str().unwrap_or("").chars().take(2000).collect::<String>()),
                    _ => return Err(invalid(format!("聊天没有 {k} 这个字段"))),
                }
            }
            c["updatedAt"] = json!(now);
            write_chat(tx, &c, None)?;
            Ok(c)
        })?;
        Ok(out)
    }

    pub fn delete_chat(&self, id: &str, actor: &str) -> Result<()> {
        let now = now_ms();
        self.write(|tx| {
            let c = read_chat(tx, id)?;
            write_chat(tx, &c, Some(now))?;
            tx.execute(
                "DELETE FROM messages_fts WHERE id IN (SELECT id FROM messages WHERE chat_id = ?1)",
                [id],
            )?;
            tx.execute(
                "UPDATE messages SET deleted_at = ?2 WHERE chat_id = ?1 AND deleted_at IS NULL",
                params![id, now],
            )?;
            log(
                tx,
                actor,
                "chat.delete",
                "",
                None,
                None,
                Some(&format!("删除聊天「{}」", str_of(&c, "name"))),
            )
        })?;
        Ok(())
    }

    pub fn list_bundles(&self, chat: &str) -> Result<Vec<Value>> {
        let conn = self.lock();
        let mut q =
            conn.prepare("SELECT data FROM bundles WHERE chat_id = ?1 ORDER BY imported_at DESC")?;
        let rows = q.query_map([chat], |r| r.get::<_, String>(0))?;
        Ok(rows
            .filter_map(|s| s.ok().and_then(|s| serde_json::from_str(&s).ok()))
            .collect())
    }

    /// 查消息，返回（按时间从早到晚的这一页, 符合条件的总数）
    pub fn list_messages(&self, f: &MessageQuery) -> Result<(Vec<Value>, usize)> {
        let mut sql = String::from(" FROM messages m WHERE m.deleted_at IS NULL");
        let mut args: Vec<String> = vec![];
        if let Some(c) = &f.chat {
            sql += " AND m.chat_id = ?";
            args.push(c.clone());
        }
        if f.unread {
            sql += " AND m.time > COALESCE((SELECT json_extract(data, '$.readUpTo') FROM chats WHERE id = m.chat_id), '')";
        }
        if let Some(t) = &f.from {
            sql += " AND m.time >= ?";
            args.push(t.clone());
        }
        if let Some(t) = &f.to {
            sql += " AND m.time <= ?";
            args.push(t.clone());
        }
        if let Some(ids) = &f.ids {
            if ids.is_empty() {
                return Ok((vec![], 0));
            }
            sql += &format!(" AND m.id IN ({})", vec!["?"; ids.len()].join(","));
            args.extend(ids.iter().cloned());
        }
        for t in f.q.as_deref().unwrap_or("").split_whitespace() {
            if t.chars().count() >= 3 {
                sql += " AND m.id IN (SELECT id FROM messages_fts WHERE messages_fts MATCH ?)";
                args.push(format!("\"{}\"", t.replace('"', "\"\"")));
            } else {
                sql += " AND (m.text LIKE ? ESCAPE '\\' OR m.sender LIKE ? ESCAPE '\\')";
                let like = format!(
                    "%{}%",
                    t.replace('\\', "\\\\")
                        .replace('%', "\\%")
                        .replace('_', "\\_")
                );
                args.push(like.clone());
                args.push(like);
            }
        }
        let conn = self.lock();
        let total: i64 = conn.query_row(
            &format!("SELECT COUNT(*){sql}"),
            rusqlite::params_from_iter(args.iter()),
            |r| r.get(0),
        )?;
        let limit = f.limit.unwrap_or(500).min(crate::MAX_LIMIT);
        let cols = MSG_COLS
            .split(", ")
            .map(|c| format!("m.{c}"))
            .collect::<Vec<_>>()
            .join(", ");
        let mut q = conn.prepare(&format!(
            "SELECT {cols}{sql} ORDER BY m.time DESC, m.bundle_at DESC, m.seq DESC LIMIT {limit} OFFSET {}",
            f.offset
        ))?;
        let mut out: Vec<Value> = q
            .query_map(rusqlite::params_from_iter(args.iter()), message_of)?
            .collect::<rusqlite::Result<_>>()?;
        out.reverse();
        Ok((out, total as usize))
    }

    pub fn delete_messages(&self, ids: &[String], actor: &str) -> Result<usize> {
        let now = now_ms();
        let (n, _) = self.write(|tx| {
            let mut n = 0;
            for id in ids {
                n += tx.execute(
                    "UPDATE messages SET deleted_at = ?2 WHERE id = ?1 AND deleted_at IS NULL",
                    params![id, now],
                )?;
                tx.execute("DELETE FROM messages_fts WHERE id = ?1", [id])?;
            }
            if n > 0 {
                log(
                    tx,
                    actor,
                    "messages.delete",
                    "",
                    None,
                    None,
                    Some(&format!("删除 {n} 条聊天消息")),
                )?;
            }
            Ok(n)
        })?;
        Ok(n)
    }

    /// 哪些发送人是「我」（界面里显示在右边，建议聊天名时跳过）
    pub fn inbox_me(&self) -> Result<Vec<String>> {
        let s: Option<String> = self
            .lock()
            .query_row("SELECT value FROM meta WHERE key = 'inbox.me'", [], |r| {
                r.get(0)
            })
            .optional()?;
        Ok(s.and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default())
    }

    pub fn set_inbox_me(&self, me: Vec<String>) -> Result<Vec<String>> {
        let mut me: Vec<String> = me
            .into_iter()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty() && s.chars().count() <= 60)
            .collect();
        me.dedup();
        me.truncate(20);
        let v = serde_json::to_string(&me).unwrap_or_else(|_| "[]".into());
        self.write(|tx| {
            tx.execute(
                "INSERT INTO meta (key, value) VALUES ('inbox.me', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [v],
            )?;
            Ok(())
        })?;
        Ok(me)
    }

    /// 选中的消息写成 Markdown（附件用 asset: 链接，界面和笔记能直接显示）
    pub fn messages_markdown(&self, f: &MessageQuery) -> Result<(String, Vec<Value>)> {
        let (msgs, _) = self.list_messages(&MessageQuery {
            limit: Some(crate::MAX_LIMIT),
            ..f.clone()
        })?;
        let mut chats: Vec<String> = vec![];
        for m in &msgs {
            let c = str_of(m, "chatId").to_string();
            if !chats.contains(&c) {
                chats.push(c);
            }
        }
        let mut md = String::new();
        for c in &chats {
            let name = self
                .get_chat(c)
                .map(|c| str_of(&c, "name").to_string())
                .unwrap_or_default();
            let part: Vec<Value> = msgs
                .iter()
                .filter(|m| str_of(m, "chatId") == c)
                .cloned()
                .collect();
            if !md.is_empty() {
                md.push('\n');
            }
            md += &wechat::render_markdown(&name, &part, |a| {
                a.get("asset")
                    .and_then(|x| x.as_str())
                    .map(|s| format!("asset:{s}"))
            });
        }
        Ok((md, msgs))
    }
}
