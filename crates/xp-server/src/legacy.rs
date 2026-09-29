//! v1 兼容接口：旧界面（ui/index.html）和旧版桌面程序的连接模式在用，行为保持不变。
//! 唯一的区别：请求本身有问题时回 400（客户端不重试），存不了时回 503（客户端稍后重试）。

use crate::{best_ui, blocking, vendor_js, ApiError, ApiResult, AppState, MARKED_JS, PURIFY_JS};
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::{Html, IntoResponse};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
use xp_core::Op;
use xp_store::{legacy_rev, mime_of, ACTOR_UI};

pub fn routes() -> Router<AppState> {
    Router::new()
        // 旧界面（单文件）挂在 /old/，新界面没构建时 / 也用它（见 web.rs）
        .route(
            "/old",
            get(|| async { axum::response::Redirect::permanent("/old/") }),
        )
        .route("/old/", get(index))
        .route("/old/index.html", get(index))
        .route("/old/vendor/marked.js", get(marked))
        .route("/old/vendor/purify.js", get(purify))
        .route("/vendor/marked.js", get(marked))
        .route("/vendor/purify.js", get(purify))
        .route("/api/ping", get(ping))
        .route("/api/state", get(state))
        .route("/api/rev", get(rev))
        .route("/api/op", post(op))
        .route("/api/asset", post(put_asset))
        .route("/api/asset/:name", get(get_asset))
}

pub(crate) async fn index(State(st): State<AppState>) -> impl IntoResponse {
    (
        [(header::CACHE_CONTROL, "no-cache")],
        Html(best_ui(st.dir())),
    )
}

fn js(body: String) -> impl IntoResponse {
    (
        [
            (header::CONTENT_TYPE, "text/javascript; charset=utf-8"),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        body,
    )
}

async fn marked(State(st): State<AppState>) -> impl IntoResponse {
    js(vendor_js(st.dir(), "marked.js", MARKED_JS))
}

async fn purify(State(st): State<AppState>) -> impl IntoResponse {
    js(vendor_js(st.dir(), "purify.js", PURIFY_JS))
}

async fn ping() -> Json<Value> {
    Json(json!({ "ok": true, "app": "xpanel", "apiVersion": crate::API_VERSION }))
}

async fn state(State(st): State<AppState>) -> ApiResult<Json<Value>> {
    Ok(Json(blocking(move || st.legacy_state()).await?))
}

async fn rev(State(st): State<AppState>) -> ApiResult<Json<Value>> {
    let r = blocking(move || st.rev()).await?;
    Ok(Json(json!({ "rev": legacy_rev(r) })))
}

/// 旧界面用 text/plain 发 JSON（避免跨域预检），这里按原样解析
async fn op(State(st): State<AppState>, body: Bytes) -> ApiResult<Json<Value>> {
    let op: Op = serde_json::from_slice(&body)
        .map_err(|e| ApiError(StatusCode::BAD_REQUEST, e.to_string()))?;
    let v = blocking(move || {
        st.apply_op(op, ACTOR_UI)?;
        st.legacy_state()
    })
    .await?;
    Ok(Json(v))
}

#[derive(Deserialize)]
struct AssetUpload {
    name: String,
    data: String,
}

async fn put_asset(State(st): State<AppState>, body: Bytes) -> ApiResult<Json<Value>> {
    let u: AssetUpload = serde_json::from_slice(&body)
        .map_err(|e| ApiError(StatusCode::BAD_REQUEST, e.to_string()))?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(u.data.as_bytes())
        .map_err(|e| ApiError(StatusCode::BAD_REQUEST, e.to_string()))?;
    let name = blocking(move || st.put_asset(&u.name, &bytes)).await?;
    Ok(Json(json!({ "name": name })))
}

async fn get_asset(
    State(st): State<AppState>,
    Path(name): Path<String>,
) -> ApiResult<impl IntoResponse> {
    let n = name.clone();
    let bytes = blocking(move || st.get_asset(&n)).await?;
    Ok((
        [
            (header::CONTENT_TYPE, mime_of(&name)),
            (header::CACHE_CONTROL, "max-age=31536000, immutable"),
        ],
        bytes,
    ))
}
