//! /api/v1/vault：密码库。这里收发的都是密文，加密解密在界面里做。
//! AI 不直接读条目内容：先 `GET /vault/index` 看有哪些，再 `POST /vault/requests` 请求取用，
//! 用户在界面上点了允许，才能从 `GET /vault/requests/{id}` 拿到（用请求里的公钥加密过的）内容。

use crate::v1::{Actor, KeyActor};
use crate::{blocking, ApiError, ApiResult, AppState};
use axum::extract::{Path, Request, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::middleware::Next;
use axum::response::Response;
use axum::routing::{get, put};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/", get(state))
        .route("/index", get(index))
        .route("/keys/:id", put(put_key))
        .route("/keys/:id/box", put(put_box))
        .route("/drops", axum::routing::post(drop_in))
        .route("/secrets/:id", put(put_secret).delete(delete_secret))
        .route("/requests", get(pending).post(create_request))
        .route("/requests/:id", get(get_request).post(resolve_request))
        .layer(axum::middleware::from_fn(same_site_only))
}

/// 密码库的接口只给自己的界面和局域网里的工具用，不给别的网站上的网页用。
/// 其他接口允许跨站调用（方便写小工具），这里不行：你在浏览器里打开的任何网页，都可能偷偷向
/// `http://主机:8765` 发请求，把密文和包着的密钥拿走去离线猜主密码。
/// - 带了 Origin（浏览器的跨站请求一定带）：必须和 Host 是同一个地址
/// - Host 必须像局域网地址（IP、localhost、不带点的机器名、.local 等），挡住把外面的域名解析到内网的做法
async fn same_site_only(req: Request, next: Next) -> Result<Response, ApiError> {
    if !same_site(req.headers()) {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "密码库的接口不能从别的网站调用".into(),
        ));
    }
    Ok(next.run(req).await)
}

fn same_site(headers: &HeaderMap) -> bool {
    let h = |k: header::HeaderName| headers.get(k).and_then(|v| v.to_str().ok());
    // 浏览器自己标明了是别的网站发起的
    if headers
        .get("sec-fetch-site")
        .is_some_and(|v| v.as_bytes().eq_ignore_ascii_case(b"cross-site"))
    {
        return false;
    }
    match (h(header::HOST), h(header::ORIGIN)) {
        // 程序内部的调用（桌面版界面）
        (None, None) => true,
        (None, Some(_)) => false,
        (Some(host), origin) => {
            lan_host(host)
                && origin.is_none_or(|o| {
                    o.split_once("://")
                        .map(|x| x.1)
                        .unwrap_or(o)
                        .eq_ignore_ascii_case(host)
                })
        }
    }
}

fn lan_host(host: &str) -> bool {
    // 去掉端口；IPv6 是 [::1]:8765 这种写法
    let name = if let Some(rest) = host.strip_prefix('[') {
        rest.split(']').next().unwrap_or("")
    } else {
        host.rsplit_once(':')
            .filter(|(_, p)| p.chars().all(|c| c.is_ascii_digit()))
            .map(|x| x.0)
            .unwrap_or(host)
    };
    let name = name.to_ascii_lowercase();
    name.parse::<std::net::IpAddr>().is_ok()
        || name == "localhost"
        || (!name.is_empty() && !name.contains('.'))
        || [
            ".local",
            ".lan",
            ".home",
            ".internal",
            ".home.arpa",
            ".ts.net",
        ]
        .iter()
        .any(|s| name.ends_with(s))
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
    #[serde(default)]
    mac: String,
}

async fn put_key(
    State(st): State<AppState>,
    Actor(actor): Actor,
    Path(id): Path<String>,
    Json(b): Json<KeyReq>,
) -> ApiResult<Json<Value>> {
    Ok(Json(
        blocking(move || st.vault_put_key(&id, &b.data, b.expect, &b.mac, &actor)).await?,
    ))
}

#[derive(Deserialize)]
struct BoxReq {
    #[serde(rename = "pub")]
    pubkey: String,
    mac: String,
}

async fn put_box(
    State(st): State<AppState>,
    _a: Actor,
    Path(id): Path<String>,
    Json(b): Json<BoxReq>,
) -> ApiResult<Json<Value>> {
    Ok(Json(
        blocking(move || st.vault_put_box(&id, &b.pubkey, &b.mac)).await?,
    ))
}

/// 快速记下一条（密文），之后再整理。锁着也能存，所以不用校验值
async fn drop_in(
    State(st): State<AppState>,
    Actor(actor): Actor,
    Json(b): Json<Value>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let v = blocking(move || st.vault_drop(b["kid"].as_str().unwrap_or(""), &b, &actor)).await?;
    Ok((StatusCode::CREATED, Json(v)))
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

#[derive(Deserialize)]
struct DeleteReq {
    expect: f64,
    mac: String,
}

async fn delete_secret(
    State(st): State<AppState>,
    Actor(actor): Actor,
    Path(id): Path<String>,
    Json(b): Json<DeleteReq>,
) -> ApiResult<StatusCode> {
    blocking(move || st.vault_delete_secret(&id, b.expect, &b.mac, &actor)).await?;
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

/// 弹窗里要告诉用户是谁在要：只认 API key 验证过的名字（`KeyActor`），自己报的名字不算
async fn create_request(
    State(st): State<AppState>,
    KeyActor(actor): KeyActor,
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
    #[serde(default)]
    mac: String,
}

async fn resolve_request(
    State(st): State<AppState>,
    Actor(actor): Actor,
    Path(id): Path<String>,
    Json(b): Json<Resolve>,
) -> ApiResult<StatusCode> {
    blocking(move || st.vault_request_resolve(&id, b.approve, b.sealed, &b.mac, &actor)).await?;
    Ok(StatusCode::NO_CONTENT)
}
