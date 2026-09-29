//! /api/v1/inbox：收件箱里导入的聊天记录（微信导出 ZIP）

use crate::v1::Actor;
use crate::{blocking, ApiError, ApiResult, AppState};
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use xp_core::{now_ms, str_of, NewItem};
use xp_store::MessageQuery;

/// 导出 ZIP 可能带视频，单独放宽（JSON 里是 base64，会大 1/3）
pub const MAX_IMPORT_BODY: usize = 768 * 1024 * 1024;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/wechat/preview",
            post(preview).layer(DefaultBodyLimit::max(MAX_IMPORT_BODY)),
        )
        .route(
            "/wechat/import",
            post(import).layer(DefaultBodyLimit::max(MAX_IMPORT_BODY)),
        )
        .route("/chats", get(list_chats))
        .route(
            "/chats/:id",
            get(get_chat).patch(update_chat).delete(delete_chat),
        )
        .route("/chats/:id/bundles", get(bundles))
        .route("/messages", get(messages))
        .route("/messages/delete", post(delete_messages))
        .route("/messages/to-item", post(to_item))
        .route("/markdown", get(markdown))
        .route("/me", get(get_me).put(put_me))
}

fn bad(m: impl Into<String>) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, m.into())
}

// ---------------------------------------------------------------- 导入

#[derive(Deserialize, Default)]
struct ImportQuery {
    chat: Option<String>,
    name: Option<String>,
}

/// 请求体两种写法：直接发 ZIP 原始内容（`curl --data-binary @x.zip`，聊天名放在 ?chat=），
/// 或 JSON `{ "data": "<base64>", "name": "文件名", "chat": "聊天名" }`（界面用这种）。
fn zip_of(headers: &HeaderMap, q: ImportQuery, body: Bytes) -> ApiResult<(Vec<u8>, ImportQuery)> {
    let is_json = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|t| t.contains("json"));
    if !is_json {
        return Ok((body.to_vec(), q));
    }
    #[derive(Deserialize)]
    struct B {
        data: String,
        name: Option<String>,
        chat: Option<String>,
    }
    let b: B = serde_json::from_slice(&body).map_err(|e| bad(format!("请求格式有误：{e}")))?;
    use base64::Engine;
    let data = base64::engine::general_purpose::STANDARD
        .decode(b.data.trim().as_bytes())
        .map_err(|_| bad("data 不是 base64"))?;
    Ok((
        data,
        ImportQuery {
            chat: b.chat.or(q.chat),
            name: b.name.or(q.name),
        },
    ))
}

async fn preview(
    State(st): State<AppState>,
    _a: Actor,
    headers: HeaderMap,
    Query(q): Query<ImportQuery>,
    body: Bytes,
) -> ApiResult<Json<Value>> {
    let (zip, _) = zip_of(&headers, q, body)?;
    Ok(Json(blocking(move || st.wechat_preview(&zip)).await?))
}

async fn import(
    State(st): State<AppState>,
    Actor(actor): Actor,
    headers: HeaderMap,
    Query(q): Query<ImportQuery>,
    body: Bytes,
) -> ApiResult<Response> {
    let (zip, q) = zip_of(&headers, q, body)?;
    let r = blocking(move || {
        let chat = match q.chat.filter(|c| !c.trim().is_empty()) {
            Some(c) => c,
            None => str_of(&st.wechat_preview(&zip)?, "suggestedChat").to_string(),
        };
        st.wechat_import(&zip, q.name.as_deref().unwrap_or(""), &chat, &actor)
    })
    .await?;
    Ok((StatusCode::CREATED, Json(r)).into_response())
}

// ---------------------------------------------------------------- 聊天

async fn list_chats(State(st): State<AppState>, _a: Actor) -> ApiResult<Json<Value>> {
    let chats = blocking(move || st.list_chats()).await?;
    Ok(Json(json!({ "chats": chats })))
}

async fn get_chat(
    State(st): State<AppState>,
    _a: Actor,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    Ok(Json(blocking(move || st.get_chat(&id)).await?))
}

async fn update_chat(
    State(st): State<AppState>,
    Actor(actor): Actor,
    Path(id): Path<String>,
    Json(patch): Json<Map<String, Value>>,
) -> ApiResult<Json<Value>> {
    Ok(Json(
        blocking(move || st.update_chat(&id, &patch, &actor)).await?,
    ))
}

async fn delete_chat(
    State(st): State<AppState>,
    Actor(actor): Actor,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    blocking(move || st.delete_chat(&id, &actor)).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn bundles(
    State(st): State<AppState>,
    _a: Actor,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let b = blocking(move || st.list_bundles(&id)).await?;
    Ok(Json(json!({ "bundles": b })))
}

// ---------------------------------------------------------------- 消息

#[derive(Deserialize, Default)]
struct MsgParams {
    chat: Option<String>,
    q: Option<String>,
    from: Option<String>,
    to: Option<String>,
    /// 逗号分隔
    ids: Option<String>,
    unread: Option<String>,
    offset: Option<usize>,
    limit: Option<usize>,
}

impl MsgParams {
    fn query(self) -> MessageQuery {
        let some = |s: Option<String>| s.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        MessageQuery {
            chat: some(self.chat),
            q: some(self.q),
            from: some(self.from),
            to: some(self.to),
            ids: some(self.ids).map(|s| {
                s.split(',')
                    .map(|x| x.trim().to_string())
                    .filter(|x| !x.is_empty())
                    .collect()
            }),
            unread: matches!(self.unread.as_deref(), Some("1" | "true" | "yes")),
            offset: self.offset.unwrap_or(0),
            limit: self.limit,
        }
    }
}

async fn messages(
    State(st): State<AppState>,
    _a: Actor,
    Query(p): Query<MsgParams>,
) -> ApiResult<Json<Value>> {
    let f = p.query();
    let (m, total) = blocking(move || st.list_messages(&f)).await?;
    Ok(Json(
        json!({ "total": total, "count": m.len(), "messages": m }),
    ))
}

#[derive(Deserialize)]
struct Ids {
    ids: Vec<String>,
}

async fn delete_messages(
    State(st): State<AppState>,
    Actor(actor): Actor,
    Json(b): Json<Ids>,
) -> ApiResult<Json<Value>> {
    let n = blocking(move || st.delete_messages(&b.ids, &actor)).await?;
    Ok(Json(json!({ "deleted": n })))
}

async fn markdown(
    State(st): State<AppState>,
    _a: Actor,
    Query(p): Query<MsgParams>,
) -> ApiResult<Response> {
    let f = p.query();
    let (md, _) = blocking(move || st.messages_markdown(&f)).await?;
    let mut r = md.into_response();
    r.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/markdown; charset=utf-8"),
    );
    Ok(r)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToItem {
    ids: Vec<String>,
    #[serde(rename = "type")]
    kind: Option<String>,
    title: Option<String>,
    category: Option<String>,
    tags: Option<Vec<String>>,
    priority: Option<String>,
    due: Option<Value>,
    /// 同时把聊天标成「已处理到」这些消息的最后一条
    #[serde(default)]
    mark_read: bool,
}

/// 选中的消息整理成一条事项或笔记（正文是 Markdown，图片直接显示）
async fn to_item(
    State(st): State<AppState>,
    Actor(actor): Actor,
    Json(b): Json<ToItem>,
) -> ApiResult<Response> {
    if b.ids.is_empty() {
        return Err(bad("没有选中消息"));
    }
    let item = blocking(move || -> Result<Value, xp_store::StoreError> {
        let f = MessageQuery {
            ids: Some(b.ids.clone()),
            ..Default::default()
        };
        let (md, msgs) = st.messages_markdown(&f)?;
        let (Some(first), Some(last)) = (msgs.first(), msgs.last()) else {
            return Err(xp_store::StoreError::NotFound("选中的消息不存在".into()));
        };
        let chat_id = str_of(first, "chatId").to_string();
        let chat = st.get_chat(&chat_id)?;
        let title = b
            .title
            .filter(|t| !t.trim().is_empty())
            .unwrap_or_else(|| format!("{} · {}", str_of(&chat, "name"), str_of(first, "time")));
        let n = NewItem {
            kind: Some(b.kind.unwrap_or_else(|| "note".into())),
            title,
            // 标题已经写了聊天名，正文去掉重复的一级标题
            body: Some(md.split_once('\n').map(|x| x.1.trim_start().to_string()).unwrap_or(md)),
            tags: Some(b.tags.unwrap_or_else(|| vec!["微信".into()])),
            category: b.category,
            priority: b.priority,
            due: b.due,
            extra: {
                let mut m = Map::new();
                m.insert(
                    "source".into(),
                    json!({"kind": "wechat", "chatId": chat_id, "chat": str_of(&chat, "name"), "messageIds": b.ids}),
                );
                m
            },
            ..Default::default()
        };
        let it = n
            .into_item(now_ms(), &actor)
            .map_err(xp_store::StoreError::Invalid)?;
        let created = st.create(vec![it], &actor)?;
        if b.mark_read {
            let t = str_of(last, "time").to_string();
            let cur = str_of(&chat, "readUpTo").to_string();
            if t > cur {
                let mut p = Map::new();
                p.insert("readUpTo".into(), json!(t));
                st.update_chat(&chat_id, &p, &actor)?;
            }
        }
        Ok(created.into_iter().next().unwrap_or(Value::Null))
    })
    .await?;
    Ok((StatusCode::CREATED, Json(item)).into_response())
}

// ---------------------------------------------------------------- 「我」

async fn get_me(State(st): State<AppState>, _a: Actor) -> ApiResult<Json<Value>> {
    let me = blocking(move || st.inbox_me()).await?;
    Ok(Json(json!({ "me": me })))
}

#[derive(Deserialize)]
struct Me {
    me: Vec<String>,
}

async fn put_me(
    State(st): State<AppState>,
    _a: Actor,
    Json(b): Json<Me>,
) -> ApiResult<Json<Value>> {
    let me = blocking(move || st.set_inbox_me(b.me)).await?;
    Ok(Json(json!({ "me": me })))
}
