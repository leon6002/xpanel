//! 界面：`web/` 用 Vite 构建到 `web/dist`，编译时整个目录编进程序，挂在 `/`。
//!
//! 带哈希的静态文件（/assets/）长期缓存，index.html 每次都重新取。
//! 没构建过新界面（比如只跑了 cargo test）时 `/` 退回旧界面；旧界面一直在 `/old/`。

use axum::extract::{Path, State};
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
        .route("/", get(home))
        .route("/index.html", get(home))
        .route(
            "/assets/*path",
            get(|Path(p): Path<String>| async move { serve(&format!("assets/{p}")) }),
        )
        // 预览阶段的地址，留着免得书签失效
        .route("/next", get(|| async { Redirect::temporary("/") }))
        .route("/next/", get(|| async { Redirect::temporary("/") }))
}

async fn home(st: State<AppState>) -> Response {
    // 只跑过 cargo 时 dist 里可能只有桌面版放的占位页（见 src-tauri/build.rs）
    let built = Dist::get("index.html")
        .is_some_and(|f| !String::from_utf8_lossy(&f.data).contains("xp-placeholder"));
    if built {
        serve("index.html")
    } else {
        crate::legacy::index(st).await.into_response()
    }
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
    StatusCode::NOT_FOUND.into_response()
}
