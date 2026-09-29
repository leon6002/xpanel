//! /api/v1：对外接口。所有写入都记到操作记录里，写明是谁改的。
//!
//! 身份：`Authorization: Bearer <key>`（`xp key create <名字>` 生成），
//! 没带 key 时用 `X-Actor` 头里的名字，都没有就记为 `api`。
//! 带了错误的 key 会被拒绝（401，读写都一样），避免记错来源。

use crate::{blocking, openapi, ApiError, ApiResult, AppState, API_VERSION};
use axum::async_trait;
use axum::extract::{FromRequestParts, Path, Query, State};
use axum::http::request::Parts;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::stream::Stream;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::convert::Infallible;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;
use xp_core::{
    export_csv, export_json, export_markdown, now_ms, stats, today_date, today_local, Filter,
    NewItem, PriorityChange,
};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/meta", get(meta))
        .route("/openapi.json", get(spec))
        .route("/items", get(list).post(create))
        .route("/items/reprioritize", post(reprioritize))
        .route("/items/:id", get(get_one).patch(update).delete(remove))
        .route("/items/:id/progress", post(progress))
        .route("/items/:id/qa", post(add_qa))
        .route("/templates", get(get_templates).put(put_templates))
        .route("/export", get(export))
        .route("/stats", get(get_stats))
        .route("/audit", get(audit))
        .route("/events", get(events))
        .route(
            "/categories",
            get(list_categories)
                .post(create_category)
                .delete(delete_category),
        )
        .route("/categories/rename", post(rename_category))
        .route("/tags", get(list_tags).delete(delete_tag))
        .route("/tags/rename", post(rename_tag))
        .route("/devices", get(list_devices).post(create_device))
        .route("/devices/heartbeat", post(heartbeat))
        .route(
            "/devices/:id",
            get(get_device).patch(update_device).delete(delete_device),
        )
        .nest("/inbox", crate::inbox::routes())
}

// ---------------------------------------------------------------- 身份

pub struct Actor(pub String);

#[async_trait]
impl FromRequestParts<AppState> for Actor {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, st: &AppState) -> Result<Self, Self::Rejection> {
        let h = |k: header::HeaderName| {
            parts
                .headers
                .get(k)
                .and_then(|v| v.to_str().ok())
                .map(str::trim)
                .map(String::from)
        };
        if let Some(auth) = h(header::AUTHORIZATION) {
            let key = auth
                .strip_prefix("Bearer ")
                .or_else(|| auth.strip_prefix("bearer "))
                .unwrap_or(&auth)
                .trim()
                .to_string();
            let st = st.clone();
            return match blocking(move || st.verify_key(&key)).await? {
                Some(name) => Ok(Actor(name)),
                None => Err(ApiError(
                    StatusCode::UNAUTHORIZED,
                    "API key 不对或已被删除".into(),
                )),
            };
        }
        let name = parts
            .headers
            .get("x-actor")
            .and_then(|v| v.to_str().ok())
            .map(|s| {
                s.trim()
                    .chars()
                    .filter(|c| !c.is_control())
                    .take(40)
                    .collect::<String>()
            })
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "api".into());
        Ok(Actor(name))
    }
}

// ---------------------------------------------------------------- 基本信息

async fn meta(State(st): State<AppState>) -> ApiResult<Json<Value>> {
    let rev = blocking(move || st.rev()).await?;
    Ok(Json(json!({
        "app": "xpanel",
        "version": env!("CARGO_PKG_VERSION"),
        "apiVersion": API_VERSION,
        "rev": rev,
        "types": xp_core::ITEM_TYPES.iter().map(|t| json!({"type": t.0, "name": t.1, "checkable": t.2})).collect::<Vec<_>>(),
        "priorities": xp_core::PRIORITIES,
    })))
}

async fn spec() -> Json<Value> {
    Json(openapi::spec())
}

// ---------------------------------------------------------------- 条目

async fn list(
    State(st): State<AppState>,
    _a: Actor,
    Query(f): Query<Filter>,
) -> ApiResult<Json<Value>> {
    let (items, total) = blocking(move || st.list(&f)).await?;
    Ok(Json(
        json!({ "total": total, "count": items.len(), "items": items }),
    ))
}

async fn get_one(
    State(st): State<AppState>,
    _a: Actor,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    Ok(Json(blocking(move || st.get(&id)).await?))
}

/// 一次可以建一条（对象）或多条（数组）
async fn create(
    State(st): State<AppState>,
    Actor(actor): Actor,
    Json(body): Json<Value>,
) -> ApiResult<Response> {
    let (inputs, many) = match body {
        Value::Array(a) => (a, true),
        v => (vec![v], false),
    };
    if inputs.is_empty() {
        return Err(bad("没有要新建的条目"));
    }
    let now = now_ms();
    let mut items = vec![];
    for (i, v) in inputs.into_iter().enumerate() {
        let n: NewItem =
            serde_json::from_value(v).map_err(|e| bad(format!("第 {} 条：{e}", i + 1)))?;
        items.push(
            n.into_item(now, &actor)
                .map_err(|e| bad(format!("第 {} 条：{e}", i + 1)))?,
        );
    }
    let created = blocking(move || st.create(items, &actor)).await?;
    let body = if many {
        json!({ "items": created })
    } else {
        created.into_iter().next().unwrap_or(Value::Null)
    };
    Ok((StatusCode::CREATED, Json(body)).into_response())
}

async fn update(
    State(st): State<AppState>,
    Actor(actor): Actor,
    Path(id): Path<String>,
    Json(patch): Json<Map<String, Value>>,
) -> ApiResult<Json<Value>> {
    Ok(Json(
        blocking(move || st.update(&id, &patch, &actor)).await?,
    ))
}

async fn remove(
    State(st): State<AppState>,
    Actor(actor): Actor,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    blocking(move || st.delete(&id, &actor)).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct ProgressBody {
    text: String,
    status: Option<String>,
    #[serde(default)]
    files: Vec<String>,
}

/// AI 回写进展：追加到条目的 agentProgress（最多保留 50 条）
async fn progress(
    State(st): State<AppState>,
    Actor(actor): Actor,
    Path(id): Path<String>,
    Json(b): Json<ProgressBody>,
) -> ApiResult<Response> {
    let text = b.text.trim().to_string();
    if text.is_empty() {
        return Err(bad("text 不能为空"));
    }
    if text.chars().count() > 20_000 {
        return Err(bad(
            "text 太长（最多 2 万字），长的内容写成文件，在 files 里给路径",
        ));
    }
    let status = b.status.unwrap_or_else(|| "working".into());
    if !["working", "done", "blocked"].contains(&status.as_str()) {
        return Err(bad(
            "status 可选 working（进行中）/ done（完成）/ blocked（卡住，需要人处理）",
        ));
    }
    let entry = json!({"at": now_ms(), "by": actor, "status": status, "text": text, "files": b.files.into_iter().take(50).collect::<Vec<_>>()});
    let it = blocking(move || st.append_to(&id, "agentProgress", entry, 50, &actor)).await?;
    Ok((StatusCode::CREATED, Json(it)).into_response())
}

#[derive(Deserialize)]
struct QaBody {
    quote: Option<String>,
    question: String,
    answer: String,
}

/// 往笔记上挂一条问答：quote 是提问针对的原文（可以不填，表示针对整篇），会记下前后文用来以后定位
async fn add_qa(
    State(st): State<AppState>,
    Actor(actor): Actor,
    Path(id): Path<String>,
    Json(b): Json<QaBody>,
) -> ApiResult<Response> {
    let (q, a) = (b.question.trim().to_string(), b.answer.trim().to_string());
    if q.is_empty() || a.is_empty() {
        return Err(bad("question 和 answer 都不能为空"));
    }
    let quote = b
        .quote
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let st2 = st.clone();
    let id2 = id.clone();
    let body = blocking(move || st2.get(&id2)).await?;
    let text = xp_core::str_of(&body, "body").to_string();
    let (prefix, suffix) = match &quote {
        Some(qt) => match text.find(qt.as_str()) {
            Some(i) => {
                let pre: String = text[..i]
                    .chars()
                    .rev()
                    .take(40)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect();
                let suf: String = text[i + qt.len()..].chars().take(40).collect();
                (pre, suf)
            }
            None => return Err(bad("quote 在笔记正文里找不到，请原样摘抄一段（不要改写）")),
        },
        None => (String::new(), String::new()),
    };
    let now = now_ms();
    let entry = json!({"id": xp_core::new_id(), "quote": quote.unwrap_or_default(), "prefix": prefix, "suffix": suffix, "at": now,
        "turns": [{"q": q, "a": a, "at": now, "by": actor}]});
    let it = blocking(move || st.append_to(&id, "qa", entry, 1000, &actor)).await?;
    Ok((StatusCode::CREATED, Json(it)).into_response())
}

async fn get_templates(State(st): State<AppState>, _a: Actor) -> ApiResult<Json<Value>> {
    let t = blocking(move || st.templates()).await?;
    Ok(Json(json!({ "templates": t })))
}

#[derive(Deserialize)]
struct TemplatesBody {
    templates: Vec<xp_core::templates::Template>,
}

async fn put_templates(
    State(st): State<AppState>,
    _a: Actor,
    Json(b): Json<TemplatesBody>,
) -> ApiResult<Json<Value>> {
    let t = blocking(move || st.set_templates(b.templates)).await?;
    Ok(Json(json!({ "templates": t })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReprioritizeBody {
    changes: Vec<PriorityChange>,
    #[serde(default, alias = "dry_run")]
    dry_run: bool,
}

async fn reprioritize(
    State(st): State<AppState>,
    Actor(actor): Actor,
    Json(b): Json<ReprioritizeBody>,
) -> ApiResult<Json<Value>> {
    let dry = b.dry_run;
    let diffs = blocking(move || st.reprioritize(&b.changes, dry, &actor)).await?;
    Ok(Json(
        json!({ "dryRun": dry, "applied": !dry, "changes": diffs }),
    ))
}

// ---------------------------------------------------------------- 导出 / 统计 / 记录

#[derive(Deserialize)]
struct ExportQuery {
    format: Option<String>,
    #[serde(flatten)]
    filter: Filter,
}

async fn export(
    State(st): State<AppState>,
    _a: Actor,
    Query(q): Query<ExportQuery>,
) -> ApiResult<Response> {
    let f = q.filter;
    let items = blocking(move || st.query(&f)).await?;
    let fmt = q.format.unwrap_or_else(|| "md".into());
    let (ctype, body) = match fmt.as_str() {
        "md" | "markdown" => (
            "text/markdown; charset=utf-8",
            export_markdown(&items, &format!("xpanel 导出 {}", today_local())),
        ),
        "csv" => ("text/csv; charset=utf-8", export_csv(&items)),
        "json" => (
            "application/json",
            export_json(&items, now_ms()).to_string(),
        ),
        other => return Err(bad(format!("format 只能是 md / csv / json，收到 {other}"))),
    };
    Ok((
        [(header::CONTENT_TYPE, HeaderValue::from_static(ctype))],
        body,
    )
        .into_response())
}

async fn get_stats(
    State(st): State<AppState>,
    _a: Actor,
    Query(mut f): Query<Filter>,
) -> ApiResult<Json<Value>> {
    f.limit = None;
    f.offset = None;
    let items = blocking(move || st.query(&f)).await?;
    Ok(Json(stats(&items, today_date())))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuditQuery {
    limit: Option<usize>,
    item_id: Option<String>,
}

async fn audit(
    State(st): State<AppState>,
    _a: Actor,
    Query(q): Query<AuditQuery>,
) -> ApiResult<Json<Value>> {
    let v = blocking(move || st.audit(q.limit.unwrap_or(100), q.item_id.as_deref())).await?;
    Ok(Json(json!({ "entries": v })))
}

/// 有写入就推一条 `change` 事件，内容是新的 rev；另外每 20 秒一条保活
async fn events(State(st): State<AppState>) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let rx = st.subscribe();
    let first = st.rev().ok();
    let head = tokio_stream::iter(first.map(|r| {
        Ok(Event::default()
            .event("hello")
            .data(json!({ "rev": r }).to_string()))
    }));
    let rest = BroadcastStream::new(rx).filter_map(|r| r.ok()).map(|rev| {
        Ok(Event::default()
            .event("change")
            .data(json!({ "rev": rev }).to_string()))
    });
    Sse::new(head.chain(rest))
        .keep_alive(KeepAlive::new().interval(std::time::Duration::from_secs(20)))
}

fn bad(m: impl Into<String>) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, m.into())
}

// ---------------------------------------------------------------- 设备

async fn list_devices(State(st): State<AppState>, _a: Actor) -> ApiResult<Json<Value>> {
    let v = blocking(move || st.list_devices()).await?;
    Ok(Json(json!({ "devices": v })))
}

async fn get_device(
    State(st): State<AppState>,
    _a: Actor,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    Ok(Json(blocking(move || st.get_device(&id)).await?))
}

async fn create_device(
    State(st): State<AppState>,
    Actor(actor): Actor,
    Json(body): Json<Map<String, Value>>,
) -> ApiResult<Response> {
    let d = blocking(move || st.create_device(&body, &actor)).await?;
    Ok((StatusCode::CREATED, Json(d)).into_response())
}

async fn update_device(
    State(st): State<AppState>,
    Actor(actor): Actor,
    Path(id): Path<String>,
    Json(patch): Json<Map<String, Value>>,
) -> ApiResult<Json<Value>> {
    Ok(Json(
        blocking(move || st.update_device(&id, &patch, &actor)).await?,
    ))
}

async fn delete_device(
    State(st): State<AppState>,
    Actor(actor): Actor,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    blocking(move || st.delete_device(&id, &actor)).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn heartbeat(
    State(st): State<AppState>,
    Json(hb): Json<xp_core::device::Heartbeat>,
) -> ApiResult<Json<Value>> {
    Ok(Json(blocking(move || st.heartbeat(&hb)).await?))
}

// ---------------------------------------------------------------- 分类和标签

async fn list_categories(State(st): State<AppState>, _a: Actor) -> ApiResult<Json<Value>> {
    let v = blocking(move || st.list_categories()).await?;
    Ok(Json(json!({ "categories": v })))
}

#[derive(Deserialize)]
struct PathBody {
    path: String,
}

async fn create_category(
    State(st): State<AppState>,
    Actor(actor): Actor,
    Json(b): Json<PathBody>,
) -> ApiResult<Response> {
    let p = blocking(move || st.create_category(&b.path, &actor)).await?;
    Ok((StatusCode::CREATED, Json(json!({ "path": p }))).into_response())
}

#[derive(Deserialize)]
struct RenameBody {
    from: String,
    to: String,
}

async fn rename_category(
    State(st): State<AppState>,
    Actor(actor): Actor,
    Json(b): Json<RenameBody>,
) -> ApiResult<Json<Value>> {
    let n = blocking(move || st.rename_category(&b.from, &b.to, &actor)).await?;
    Ok(Json(json!({ "changed": n })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteCategory {
    path: String,
    /// parent（默认，条目移到上一级）/ none（条目变成未分类）
    move_to: Option<String>,
}

async fn delete_category(
    State(st): State<AppState>,
    Actor(actor): Actor,
    Query(q): Query<DeleteCategory>,
) -> ApiResult<Json<Value>> {
    let to_parent = q.move_to.as_deref() != Some("none");
    let n = blocking(move || st.delete_category(&q.path, to_parent, &actor)).await?;
    Ok(Json(json!({ "changed": n })))
}

async fn list_tags(State(st): State<AppState>, _a: Actor) -> ApiResult<Json<Value>> {
    let v = blocking(move || st.list_tags()).await?;
    Ok(Json(json!({ "tags": v })))
}

async fn rename_tag(
    State(st): State<AppState>,
    Actor(actor): Actor,
    Json(b): Json<RenameBody>,
) -> ApiResult<Json<Value>> {
    let n = blocking(move || st.rename_tag(&b.from, &b.to, &actor)).await?;
    Ok(Json(json!({ "changed": n })))
}

#[derive(Deserialize)]
struct TagQuery {
    tag: String,
}

async fn delete_tag(
    State(st): State<AppState>,
    Actor(actor): Actor,
    Query(q): Query<TagQuery>,
) -> ApiResult<Json<Value>> {
    let n = blocking(move || st.delete_tag(&q.tag, &actor)).await?;
    Ok(Json(json!({ "changed": n })))
}
