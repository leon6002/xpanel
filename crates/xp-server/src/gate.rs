//! 局域网访问的权限：主机打开「要令牌」后，别的电脑和浏览器要带一把令牌（API key）才能用接口。
//!
//! - 本机自己访问（127.0.0.1、桌面版在进程里调）一律放行，不用令牌
//! - 令牌可以放在 `X-Xpanel-Token` 头、`Authorization: Bearer` 头，或 cookie `xp_token`（浏览器登录后由
//!   `/api/v1/auth/login` 种下，HttpOnly + SameSite=Strict，图片、SSE 也能带上）
//! - 界面的静态文件（`/`、`/assets/…`、旧界面）不用令牌，接口（`/api/…`）要；`/api/ping` 和 `/api/v1/auth/*` 例外
//! - 只有 `Authorization` 里的 key 算「是谁」（记进操作记录）；cookie 和 `X-Xpanel-Token` 只管能不能进
//! - 改权限、管令牌（`/api/v1/access`）只能在主机本机上做
//!
//! 令牌查过一次记 30 秒，免得每个请求都查库；在本进程里改了令牌或权限马上作废（`Store::access_gen`），
//! 别的进程（比如 `xp key delete`）改的最多 30 秒后生效。

use crate::{blocking, ApiError, ApiResult, AppState};
use axum::extract::{ConnectInfo, Path, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Extension, Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use xp_store::Access;

pub const COOKIE: &str = "xp_token";
const TOKEN_TTL: Duration = Duration::from_secs(30);
const ACCESS_TTL: Duration = Duration::from_secs(5);

/// 这个请求是谁发的：本机还是局域网里别的地方、带没带对令牌、主机现在的权限
#[derive(Clone, Debug)]
pub struct Caller {
    pub local: bool,
    /// 带了有效的令牌（令牌的名字）
    pub token: Option<String>,
    pub access: Access,
}

impl Caller {
    /// 能进接口：本机、没要求令牌、或带对了令牌
    pub fn allowed(&self) -> bool {
        self.local || !self.access.require_token || self.token.is_some()
    }
}

#[derive(Default)]
pub struct Gate {
    cache: Mutex<Cache>,
}

#[derive(Default)]
struct Cache {
    gen: u64,
    access: Option<(Access, Instant)>,
    tokens: HashMap<String, (Option<String>, Instant)>,
}

impl Gate {
    fn lock(&self) -> std::sync::MutexGuard<'_, Cache> {
        self.cache.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 本进程里改过令牌或权限就把缓存清掉
    fn fresh(&self, st: &AppState) -> std::sync::MutexGuard<'_, Cache> {
        let mut c = self.lock();
        let g = st.access_gen();
        if c.gen != g {
            *c = Cache {
                gen: g,
                ..Default::default()
            };
        }
        c
    }

    async fn access(&self, st: &AppState) -> ApiResult<Access> {
        if let Some((a, at)) = self.fresh(st).access {
            if at.elapsed() < ACCESS_TTL {
                return Ok(a);
            }
        }
        let s = st.clone();
        let a = blocking(move || s.access()).await?;
        self.fresh(st).access = Some((a, Instant::now()));
        Ok(a)
    }

    async fn check(&self, st: &AppState, token: &str) -> ApiResult<Option<String>> {
        if let Some((name, at)) = self.fresh(st).tokens.get(token) {
            if at.elapsed() < TOKEN_TTL {
                return Ok(name.clone());
            }
        }
        let (s, t) = (st.clone(), token.to_string());
        let name = blocking(move || s.verify_key(&t)).await?;
        let mut c = self.fresh(st);
        if c.tokens.len() > 256 {
            c.tokens.clear();
        }
        c.tokens
            .insert(token.to_string(), (name.clone(), Instant::now()));
        Ok(name)
    }
}

/// 请求里带的令牌：专门的头 > Authorization > cookie
fn token_of(h: &HeaderMap) -> Option<String> {
    let s = |k: &str| h.get(k).and_then(|v| v.to_str().ok()).map(str::trim);
    if let Some(t) = s("x-xpanel-token").filter(|t| !t.is_empty()) {
        return Some(t.to_string());
    }
    if let Some(a) = s("authorization") {
        let t = a
            .strip_prefix("Bearer ")
            .or_else(|| a.strip_prefix("bearer "))
            .unwrap_or(a)
            .trim();
        if !t.is_empty() {
            return Some(t.to_string());
        }
    }
    h.get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|kv| kv.trim().split_once('='))
        .find(|(k, _)| *k == COOKIE)
        .map(|(_, v)| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// 没有连接信息的是程序内部的调用（桌面版界面在进程里调），算本机
fn is_local(req: &Request) -> bool {
    req.extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .is_none_or(|c| c.0.ip().to_canonical().is_loopback())
}

/// 不用令牌也能访问的：界面的静态文件、ping、登录
fn open_path(p: &str) -> bool {
    !p.starts_with("/api/") || p == "/api/ping" || p.starts_with("/api/v1/auth/")
}

pub fn need_token() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({
            "error": "这台主机打开了「局域网访问要令牌」，请先输入令牌（在主机的设置里生成）",
            "needToken": true
        })),
    )
        .into_response()
}

pub async fn middleware(
    State((st, gate)): State<(AppState, Arc<Gate>)>,
    mut req: Request,
    next: Next,
) -> Result<Response, ApiError> {
    let local = is_local(&req);
    let access = gate.access(&st).await?;
    let token = match token_of(req.headers()) {
        Some(t) if !local || access.require_token => gate.check(&st, &t).await?,
        _ => None,
    };
    let caller = Caller {
        local,
        token,
        access,
    };
    if !caller.allowed() && !open_path(req.uri().path()) {
        return Ok(need_token());
    }
    req.extensions_mut().insert(caller);
    Ok(next.run(req).await)
}

// ---------------------------------------------------------------- 登录（浏览器）

pub fn auth_routes() -> Router<AppState> {
    Router::new()
        .route("/status", get(status))
        .route("/login", post(login))
        .route("/logout", post(logout))
}

/// 界面打开时先问一下：要不要令牌、这个浏览器带没带对
async fn status(Extension(c): Extension<Caller>) -> Json<Value> {
    Json(json!({
        "requireToken": c.access.require_token,
        "remoteAi": c.access.remote_ai,
        "local": c.local,
        "ok": c.allowed(),
        "name": c.token,
    }))
}

#[derive(Deserialize)]
struct Login {
    token: String,
}

fn cookie(v: &str, max_age: u64) -> HeaderValue {
    HeaderValue::from_str(&format!(
        "{COOKIE}={v}; Path=/; Max-Age={max_age}; HttpOnly; SameSite=Strict"
    ))
    .unwrap_or_else(|_| HeaderValue::from_static("xp_token=; Path=/; Max-Age=0"))
}

async fn login(State(st): State<AppState>, Json(b): Json<Login>) -> ApiResult<Response> {
    let t = b.token.trim().to_string();
    // 令牌只会是 xp_ 加十六进制，别的字符一律不认，也不会写进 cookie
    if t.is_empty() || t.len() > 200 || !t.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err(ApiError(StatusCode::UNAUTHORIZED, "令牌不对".into()));
    }
    let k = t.clone();
    let name = blocking(move || st.verify_key(&k))
        .await?
        .ok_or_else(|| ApiError(StatusCode::UNAUTHORIZED, "令牌不对，或者已经被删了".into()))?;
    let mut r = Json(json!({ "ok": true, "name": name })).into_response();
    r.headers_mut()
        .insert(header::SET_COOKIE, cookie(&t, 60 * 60 * 24 * 365));
    Ok(r)
}

async fn logout() -> Response {
    let mut r = Json(json!({ "ok": true })).into_response();
    r.headers_mut().insert(header::SET_COOKIE, cookie("", 0));
    r
}

// ---------------------------------------------------------------- 权限和令牌（只在主机本机）

pub fn access_routes() -> Router<AppState> {
    Router::new()
        .route("/", get(get_access).put(put_access))
        .route("/tokens", post(create_token))
        .route("/tokens/:name", delete(delete_token))
        .layer(axum::middleware::from_fn(local_only))
}

async fn local_only(req: Request, next: Next) -> Result<Response, ApiError> {
    let local = req
        .extensions()
        .get::<Caller>()
        .map(|c| c.local)
        .unwrap_or_else(|| is_local(&req));
    if !local {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "令牌和局域网权限只能在主机这台电脑上改".into(),
        ));
    }
    Ok(next.run(req).await)
}

async fn get_access(State(st): State<AppState>) -> ApiResult<Json<Value>> {
    let (a, keys) = blocking(move || Ok((st.access()?, st.list_keys()?))).await?;
    Ok(Json(json!({ "access": a, "tokens": keys })))
}

async fn put_access(State(st): State<AppState>, Json(a): Json<Access>) -> ApiResult<Json<Value>> {
    let a = blocking(move || st.set_access(a)).await?;
    Ok(Json(json!({ "access": a })))
}

#[derive(Deserialize)]
struct NewToken {
    name: String,
}

async fn create_token(State(st): State<AppState>, Json(b): Json<NewToken>) -> ApiResult<Response> {
    let name = b.name.trim().to_string();
    let n = name.clone();
    let token = blocking(move || st.create_key(&n)).await?;
    Ok((
        StatusCode::CREATED,
        Json(json!({ "name": name, "token": token })),
    )
        .into_response())
}

async fn delete_token(
    State(st): State<AppState>,
    Path(name): Path<String>,
) -> ApiResult<Json<Value>> {
    let a = blocking(move || {
        st.delete_key(&name)?;
        st.access()
    })
    .await?;
    Ok(Json(json!({ "ok": true, "access": a })))
}
