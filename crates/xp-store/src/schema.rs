//! 数据库结构与迁移。用 SQLite 的 user_version 记录版本，每次升级前先备份。

use crate::Result;
use rusqlite::Connection;

/// 每个元素是一次升级要执行的 SQL，下标 + 1 就是升级后的版本号
const MIGRATIONS: &[&str] = &[
    // v1：条目、全文索引、附件、操作记录、API key、元数据
    r#"
    CREATE TABLE items (
        id          TEXT PRIMARY KEY,
        type        TEXT NOT NULL DEFAULT '',
        title       TEXT NOT NULL DEFAULT '',
        body        TEXT NOT NULL DEFAULT '',
        done        INTEGER NOT NULL DEFAULT 0,
        pinned      INTEGER NOT NULL DEFAULT 0,
        priority    TEXT,
        device      TEXT NOT NULL DEFAULT '',
        created_at  REAL NOT NULL DEFAULT 0,
        updated_at  REAL NOT NULL DEFAULT 0,
        deleted_at  REAL,
        data        TEXT NOT NULL
    );
    CREATE INDEX items_type_done ON items(type, done) WHERE deleted_at IS NULL;
    CREATE INDEX items_updated ON items(updated_at);

    CREATE VIRTUAL TABLE items_fts USING fts5(id UNINDEXED, title, body, tokenize = 'trigram');

    CREATE TABLE assets (
        name        TEXT PRIMARY KEY,
        mime        TEXT NOT NULL,
        size        INTEGER NOT NULL,
        created_at  REAL NOT NULL
    );

    CREATE TABLE audit_log (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        at       REAL NOT NULL,
        actor    TEXT NOT NULL,
        action   TEXT NOT NULL,
        item_id  TEXT,
        note     TEXT,
        before   TEXT,
        after    TEXT
    );
    CREATE INDEX audit_item ON audit_log(item_id);

    CREATE TABLE api_keys (
        name        TEXT PRIMARY KEY,
        key_hash    TEXT NOT NULL UNIQUE,
        created_at  REAL NOT NULL,
        last_used   REAL
    );

    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta(key, value) VALUES ('rev', '1');
    "#,
    // v2：设备（名字唯一；条目的 device 字段存名字）
    r#"
    CREATE TABLE devices (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        last_seen   REAL,
        created_at  REAL NOT NULL,
        updated_at  REAL NOT NULL,
        deleted_at  REAL,
        data        TEXT NOT NULL
    );
    CREATE UNIQUE INDEX devices_name ON devices(name) WHERE deleted_at IS NULL;
    "#,
    // v3：手工建的分类（条目上用到的分类不必在这里，这张表让空分类也能存在）
    r#"
    CREATE TABLE categories (
        path        TEXT PRIMARY KEY,
        created_at  REAL NOT NULL
    );
    "#,
    // v4：收件箱里导入的聊天（微信导出 ZIP）。消息按「聊天 + 指纹」去重，重复导入不会多出来
    r#"
    CREATE TABLE chats (
        id          TEXT PRIMARY KEY,
        source      TEXT NOT NULL,
        name        TEXT NOT NULL,
        created_at  REAL NOT NULL,
        updated_at  REAL NOT NULL,
        deleted_at  REAL,
        data        TEXT NOT NULL
    );
    CREATE UNIQUE INDEX chats_name ON chats(source, name) WHERE deleted_at IS NULL;

    CREATE TABLE bundles (
        id          TEXT PRIMARY KEY,
        chat_id     TEXT NOT NULL,
        imported_at REAL NOT NULL,
        data        TEXT NOT NULL
    );
    CREATE INDEX bundles_chat ON bundles(chat_id);

    CREATE TABLE messages (
        id          TEXT PRIMARY KEY,
        chat_id     TEXT NOT NULL,
        bundle_id   TEXT NOT NULL,
        bundle_at   REAL NOT NULL,
        seq         INTEGER NOT NULL,
        time        TEXT NOT NULL,
        sender      TEXT NOT NULL,
        text        TEXT NOT NULL,
        attachments TEXT NOT NULL DEFAULT '[]',
        fp          TEXT NOT NULL,
        deleted_at  REAL
    );
    CREATE UNIQUE INDEX messages_fp ON messages(chat_id, fp);
    CREATE INDEX messages_order ON messages(chat_id, time, bundle_at, seq);

    CREATE VIRTUAL TABLE messages_fts USING fts5(id UNINDEXED, sender, text, tokenize = 'trigram');
    "#,
];

pub const SCHEMA_VERSION: i64 = MIGRATIONS.len() as i64;

pub fn migrate(conn: &Connection) -> Result<()> {
    let v: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if v > SCHEMA_VERSION {
        return Err(crate::StoreError::Unavailable(format!(
            "数据库版本 {v} 比程序支持的 {SCHEMA_VERSION} 新，请升级 xpanel"
        )));
    }
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(v as usize) {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", (i + 1) as i64)?;
        tx.commit()?;
    }
    Ok(())
}
