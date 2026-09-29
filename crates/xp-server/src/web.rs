//! 新界面：`web/` 用 Vite 构建到 `web/dist`，编译时整个目录编进程序，挂在 `/next/`。
//!
//! 单页应用：找不到的路径都回 index.html。带哈希的静态文件长期缓存，index.html 每次都重新取。

use axum::extract::Path;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::get;
use axum::Router;
use rust_embed::RustEmbed;

use crate::AppState;

#[derive(RustEmbed)]
#[folder = "../../web/dist"]
#[allow_missing = true]
struct Dist;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/next", get(|| async { Redirect::permanent("/next/") }))
        .route("/next/", get(|| async { serve("index.html") }))
        .route(
            "/next/*path",
            get(|Path(p): Path<String>| async move { serve(&p) }),
        )
}

fn serve(path: &str) -> Response {
    if let Some(f) = Dist::get(path) {
        let cache = if path.starts_with("assets/") {
            "public, max-age=31536000, immutable"
        } else {
            "no-cache"
        };
        return (
            [
                (header::CONTENT_TYPE, f.metadata.mimetype().to_string()),
                (header::CACHE_CONTROL, cache.to_string()),
            ],
            f.data.into_owned(),
        )
            .into_response();
    }
    // 静态文件缺了就是真的 404；其余当作界面里的页面地址
    if path.starts_with("assets/") || (path.contains('.') && !path.ends_with(".html")) {
        return StatusCode::NOT_FOUND.into_response();
    }
    match Dist::get("index.html") {
        Some(f) => (
            [
                (header::CONTENT_TYPE, "text/html; charset=utf-8"),
                (header::CACHE_CONTROL, "no-cache"),
            ],
            f.data.into_owned(),
        )
            .into_response(),
        None => (
            StatusCode::SERVICE_UNAVAILABLE,
            [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
            "新界面还没构建：在 web/ 里运行 npm install && npm run build，再重新编译程序。",
        )
            .into_response(),
    }
}
