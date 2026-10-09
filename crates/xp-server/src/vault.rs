//! /api/v1/vault：密码库。这里收发的都是密文，加密解密在界面里做。
//! AI 不直接读条目内容：先 `GET /vault/index` 看有哪些，再 `POST /vault/requests` 请求取用，
//! 用户在界面上点了允许，才能从 `GET /vault/requests/{id}` 拿到（用请求里的公钥加密过的）内容。

use crate::v1::Actor;
use crate::{blocking, ApiResult, AppState};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, put};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/", get(state))
        .route("/index", get(index))
        .route("/keys/:id", put(put_key))
        .route("/secrets/:id", put(put_secret).delete(delete_secret))
        .route("/requests", get(pending).post(create_request))
        .route("/requests/:id", get(get_request).post(resolve_request))
}

async fn state(State(st): State<AppState>, _a: Actor) -> ApiResult<Json<Value>> {
    Ok(Json(blocking(move || st.vault_state()).await?))
}

async fn index(State(st): State<AppState>, _a: Actor) -> ApiResult<Json<Value>> {
    let v = blocking(move || st.vault_index()).await?;
    Ok(Json(json!({ "secrets": v })))
}

#[derive(Deserialize)]
struct KeyReq {
    data: Value,
    #[serde(default)]
    expect: Option<f64>,
}

async fn put_key(
    State(st): State<AppState>,
    Actor(actor): Actor,
    Path(id): Path<String>,
    Json(b): Json<KeyReq>,
) -> ApiResult<Json<Value>> {
    Ok(Json(
        blocking(move || st.vault_put_key(&id, &b.data, b.expect, &actor)).await?,
    ))
}

async fn put_secret(
    State(st): State<AppState>,
    Actor(actor): Actor,
    Path(id): Path<String>,
    Json(b): Json<Value>,
) -> ApiResult<Json<Value>> {
    Ok(Json(
        blocking(move || st.vault_put_secret(&id, &b, &actor)).await?,
    ))
}

async fn delete_secret(
    State(st): State<AppState>,
    Actor(actor): Actor,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    blocking(move || st.vault_delete_secret(&id, &actor)).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn pending(State(st): State<AppState>, _a: Actor) -> ApiResult<Json<Value>> {
    Ok(Json(json!({ "requests": st.vault_requests_pending() })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NewRequest {
    secret_id: String,
    #[serde(default)]
    reason: String,
    #[serde(rename = "pub")]
    pubkey: String,
}

async fn create_request(
    State(st): State<AppState>,
    Actor(actor): Actor,
    Json(b): Json<NewRequest>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let v = blocking(move || st.vault_request_create(&b.secret_id, &b.reason, &b.pubkey, &actor))
        .await?;
    Ok((StatusCode::CREATED, Json(v)))
}

async fn get_request(
    State(st): State<AppState>,
    _a: Actor,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    Ok(Json(blocking(move || st.vault_request_get(&id)).await?))
}

#[derive(Deserialize)]
struct Resolve {
    approve: bool,
    #[serde(default)]
    sealed: Option<Value>,
}

async fn resolve_request(
    State(st): State<AppState>,
    Actor(actor): Actor,
    Path(id): Path<String>,
    Json(b): Json<Resolve>,
) -> ApiResult<StatusCode> {
    blocking(move || st.vault_request_resolve(&id, b.approve, b.sealed, &actor)).await?;
    Ok(StatusCode::NO_CONTENT)
}
