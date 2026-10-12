//! 局域网里叫这台主机上的 AI（`/api/v1/agents`）。
//!
//! 只有桌面版当主机时才有（它把 [`AgentHost`] 交给服务）；命令行的 `xp serve` 没有。
//! 要主机在设置里打开「局域网访问要令牌」和「允许局域网叫本机的 AI」，并且请求带对了令牌；主机本机访问不受限。
//!
//! 只认 AI 的名字，命令用主机自己设置里的，不接受对方传来的命令。
//! 流程：界面先连上 `GET /agents/events`（SSE，这台主机上从局域网发起的 AI 每一步都推过来），
//! 再 `POST /agents/ask`（一直等到 AI 答完才返回）；要确认的事用 `/agents/runs/{run}/decide` 回答，
//! `/agents/runs/{run}/stop` 停止。发起的那个请求断了（关了页面），这次任务也就停了。

use crate::gate::Caller;
use crate::{ApiError, ApiResult, AppState};
use axum::extract::Path;
use axum::http::StatusCode;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use futures_util::stream::Stream;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::convert::Infallible;
use std::sync::{Arc, Mutex};
use tokio::sync::broadcast;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;

/// 一次问答的请求（字段和桌面版的 ask_ai 一样）
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AskReq {
    /// AI 的名字（主机设置里的）
    pub agent: String,
    pub cwd: String,
    pub prompt: String,
    /// 附件名：主机自己的附件，直接读
    pub images: Vec<String>,
    pub key: String,
    /// 这一次的编号（界面生成），进展事件和确认都用它
    pub run: String,
    pub resume: Option<String>,
}

/// 桌面版主机提供：列出能在后台回答的 AI、跑一次、回答确认、停止
pub trait AgentHost: Send + Sync + 'static {
    /// `{agents: [{name}], device: {id, hostname}}`：device 是主机在设备表里的那条，界面用它找主机上的项目文件夹
    fn agents(&self) -> Value;
    /// 跑到出结果为止（会阻塞）。每一步调 emit（`{run, type: step|ask|asked|end, …}`，和桌面版的 ai-run 事件一样）
    fn ask(&self, req: AskReq, emit: Box<dyn Fn(Value) + Send + Sync>) -> Result<Value, String>;
    fn decide(&self, run: &str, id: &str, decision: &str) -> Result<(), String>;
    fn stop(&self, run: &str);
}

pub struct Remote {
    host: Option<Arc<dyn AgentHost>>,
    events: broadcast::Sender<Value>,
    /// 从局域网发起、还没结束的
    runs: Mutex<HashSet<String>>,
}

impl Remote {
    pub fn new(host: Option<Arc<dyn AgentHost>>) -> Arc<Self> {
        Arc::new(Remote {
            host,
            events: broadcast::channel(256).0,
            runs: Mutex::new(HashSet::new()),
        })
    }

    fn runs(&self) -> std::sync::MutexGuard<'_, HashSet<String>> {
        self.runs.lock().unwrap_or_else(|e| e.into_inner())
    }
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/", get(list))
        .route("/events", get(events))
        .route("/ask", post(ask))
        .route("/runs/:run/decide", post(decide))
        .route("/runs/:run/stop", post(stop))
        .layer(axum::middleware::from_fn(crate::vault::same_site_only))
}

/// 为什么叫不了（None = 能叫）
fn blocked(c: &Caller, r: &Remote) -> Option<&'static str> {
    if r.host.is_none() {
        return Some("这台主机不是桌面版（命令行开的服务），叫不了 AI");
    }
    if c.local {
        return None;
    }
    if !c.access.remote_ai || !c.access.require_token {
        return Some(
            "主机没有打开「允许局域网叫本机的 AI」（在主机的设置里，要先打开「局域网访问要令牌」）",
        );
    }
    if c.token.is_none() {
        return Some("要带令牌才能叫主机上的 AI");
    }
    None
}

fn guard(c: &Caller, r: &Remote) -> ApiResult<Arc<dyn AgentHost>> {
    match (blocked(c, r), &r.host) {
        (None, Some(h)) => Ok(h.clone()),
        (why, _) => Err(ApiError(
            StatusCode::FORBIDDEN,
            why.unwrap_or("叫不了 AI").into(),
        )),
    }
}

fn caller(c: Option<Extension<Caller>>) -> Caller {
    // 没过 gate 的（测试里直接调路由）当本机
    c.map(|e| e.0).unwrap_or(Caller {
        local: true,
        token: None,
        access: Default::default(),
    })
}

async fn list(c: Option<Extension<Caller>>, Extension(r): Extension<Arc<Remote>>) -> Json<Value> {
    let c = caller(c);
    match (blocked(&c, &r), &r.host) {
        (None, Some(h)) => {
            let h = h.clone();
            let v = tokio::task::spawn_blocking(move || h.agents())
                .await
                .unwrap_or_else(|_| json!({}));
            Json(json!({
                "enabled": true,
                "agents": v.get("agents").cloned().unwrap_or_else(|| json!([])),
                "device": v.get("device").cloned().unwrap_or(Value::Null),
            }))
        }
        (why, _) => Json(json!({ "enabled": false, "reason": why, "agents": [] })),
    }
}

async fn events(
    c: Option<Extension<Caller>>,
    Extension(r): Extension<Arc<Remote>>,
) -> ApiResult<Sse<impl Stream<Item = Result<Event, Infallible>>>> {
    guard(&caller(c), &r)?;
    let rx = r.events.subscribe();
    let head = tokio_stream::iter([Ok(Event::default().event("hello").data("{}"))]);
    let rest = BroadcastStream::new(rx)
        .filter_map(|v| v.ok())
        .map(|v| Ok(Event::default().event("ai").data(v.to_string())));
    Ok(Sse::new(head.chain(rest))
        .keep_alive(KeepAlive::new().interval(std::time::Duration::from_secs(20))))
}

fn valid_run(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// 请求断了（关了页面）时停掉这次任务
struct StopOnDrop {
    host: Arc<dyn AgentHost>,
    remote: Arc<Remote>,
    run: String,
    done: bool,
}

impl Drop for StopOnDrop {
    fn drop(&mut self) {
        if !self.done {
            self.host.stop(&self.run);
        }
        self.remote.runs().remove(&self.run);
    }
}

async fn ask(
    c: Option<Extension<Caller>>,
    Extension(r): Extension<Arc<Remote>>,
    Json(req): Json<AskReq>,
) -> ApiResult<Json<Value>> {
    let host = guard(&caller(c), &r)?;
    if !valid_run(&req.run) {
        return Err(ApiError(StatusCode::BAD_REQUEST, "run 编号不对".into()));
    }
    if req.agent.trim().is_empty() || req.prompt.trim().is_empty() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "要写 AI 的名字和提示词".into(),
        ));
    }
    if !r.runs().insert(req.run.clone()) {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "这个编号的任务已经在跑了".into(),
        ));
    }
    let mut g = StopOnDrop {
        host: host.clone(),
        remote: r.clone(),
        run: req.run.clone(),
        done: false,
    };
    let tx = r.events.clone();
    let out = tokio::task::spawn_blocking(move || {
        host.ask(
            req,
            Box::new(move |v| {
                let _ = tx.send(v);
            }),
        )
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()));
    g.done = true;
    match out? {
        Ok(v) => Ok(Json(v)),
        // AI 那边的失败（没装、超时、被停止）：请求本身没问题，主机暂时做不了
        Err(m) => Err(ApiError(StatusCode::BAD_GATEWAY, m)),
    }
}

#[derive(Deserialize)]
struct Decide {
    id: String,
    decision: String,
}

async fn decide(
    c: Option<Extension<Caller>>,
    Extension(r): Extension<Arc<Remote>>,
    Path(run): Path<String>,
    Json(d): Json<Decide>,
) -> ApiResult<Json<Value>> {
    let host = guard(&caller(c), &r)?;
    // 只能回答从局域网发起的；主机自己的确认只在主机的窗口里点
    if !r.runs().contains(&run) {
        return Err(ApiError(StatusCode::NOT_FOUND, "这次任务已经结束了".into()));
    }
    host.decide(&run, &d.id, &d.decision)
        .map_err(|m| ApiError(StatusCode::CONFLICT, m))?;
    Ok(Json(json!({ "ok": true })))
}

async fn stop(
    c: Option<Extension<Caller>>,
    Extension(r): Extension<Arc<Remote>>,
    Path(run): Path<String>,
) -> ApiResult<Json<Value>> {
    let host = guard(&caller(c), &r)?;
    if r.runs().contains(&run) {
        host.stop(&run);
    }
    Ok(Json(json!({ "ok": true })))
}
