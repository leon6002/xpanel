//! xpanel HTTP 服务（axum）。
//!
//! - `/`、`/api/state`、`/api/op` 等：v1 兼容接口，旧界面和旧版连接模式照常能用
//! - `/api/v1/*`：对外接口，给外部 AI、脚本和 `xp` 命令行用，文档见 `/api/v1/openapi.json`
//! - `/api/v1/events`：SSE，数据有变化时推送新的 rev
//! - `/next/`：新界面（React，源码在 web/，构建产物编进程序）

mod inbox;
mod legacy;
mod openapi;
mod v1;
mod web;

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Json, Router};
use serde_json::json;
use std::future::Future;
use std::path::Path;
use std::sync::Arc;
use tower_http::cors::CorsLayer;
use xp_store::{Store, StoreError};

pub const UI_HTML: &str = include_str!("../../../ui/index.html");
pub const MARKED_JS: &str = include_str!("../../../ui/vendor/marked.js");
pub const PURIFY_JS: &str = include_str!("../../../ui/vendor/purify.js");
pub const DEFAULT_PORT: u16 = 8765;
/// /api/v1 的协议版本，不兼容的改动才加 1
pub const API_VERSION: u32 = 1;
/// 请求体上限：截图、附件走 base64（体积大约 4/3 倍），界面单个附件限制 25MB
pub const MAX_BODY: usize = 64 * 1024 * 1024;

pub type AppState = Arc<Store>;

pub fn router(store: Arc<Store>) -> Router {
    Router::new()
        .merge(legacy::routes())
        .nest("/api/v1", v1::routes())
        .merge(web::routes())
        .layer(axum::extract::DefaultBodyLimit::max(MAX_BODY))
        .layer(CorsLayer::permissive())
        .with_state(store)
}

// ---------------------------------------------------------------- 界面热更新
// 数据文件夹里放 ui/index.html（版本号更高）就会替换程序自带的界面，不用重新打包

pub fn ui_version(html: &str) -> u32 {
    let key = "name=\"wb-ui-version\" content=\"";
    html.find(key)
        .and_then(|i| {
            html[i + key.len()..]
                .split('"')
                .next()
                .and_then(|v| v.parse().ok())
        })
        .unwrap_or(0)
}

/// 自带界面和数据文件夹里的界面，取版本号更高的那个
pub fn best_ui(dir: &Path) -> String {
    if let Ok(h) = std::fs::read_to_string(dir.join("ui").join("index.html")) {
        if ui_version(&h) > ui_version(UI_HTML) {
            return h;
        }
    }
    UI_HTML.to_string()
}

pub fn vendor_js(dir: &Path, name: &str, builtin: &str) -> String {
    std::fs::read_to_string(dir.join("ui").join("vendor").join(name))
        .unwrap_or_else(|_| builtin.to_string())
}

// ---------------------------------------------------------------- 错误

pub struct ApiError(pub StatusCode, pub String);

impl From<StoreError> for ApiError {
    fn from(e: StoreError) -> Self {
        match e {
            StoreError::Invalid(m) => ApiError(StatusCode::BAD_REQUEST, m),
            StoreError::NotFound(m) => ApiError(StatusCode::NOT_FOUND, m),
            StoreError::Unavailable(m) => ApiError(StatusCode::SERVICE_UNAVAILABLE, m),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

pub type ApiResult<T> = Result<T, ApiError>;

/// 存储层是同步的（SQLite），放到阻塞线程池里跑
pub(crate) async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, StoreError> + Send + 'static,
) -> ApiResult<T> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .map_err(ApiError::from)
}

// ---------------------------------------------------------------- 启动

/// 同步绑定端口（这样端口被占用能马上报错），之后交给 `serve` 使用
pub fn bind(port: u16) -> Result<std::net::TcpListener, String> {
    let l = std::net::TcpListener::bind(("0.0.0.0", port))
        .map_err(|e| format!("局域网服务无法使用端口 {port}：{e}"))?;
    l.set_nonblocking(true).map_err(|e| e.to_string())?;
    Ok(l)
}

/// 在当前 tokio 运行时里提供服务，直到 `shutdown` 完成
pub async fn serve(
    store: Arc<Store>,
    listener: std::net::TcpListener,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> std::io::Result<()> {
    let l = tokio::net::TcpListener::from_std(listener)?;
    axum::serve(l, router(store))
        .with_graceful_shutdown(shutdown)
        .await
}

/// 命令行用：自己建运行时，Ctrl+C 退出
pub fn serve_blocking(store: Arc<Store>, port: u16) -> Result<(), String> {
    let l = bind(port)?;
    let rt = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
    println!("xpanel 服务：http://0.0.0.0:{port}/   接口文档：http://127.0.0.1:{port}/api/v1/openapi.json");
    println!("数据：{}", store.dir().display());
    rt.block_on(serve(store, l, async {
        let _ = tokio::signal::ctrl_c().await;
    }))
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests;
