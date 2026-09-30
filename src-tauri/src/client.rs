//! 连接模式：读写主机（v1 兼容接口），连不上或主机暂时存不了时先存在本机，恢复后自动补传。
//!
//! 本机文件（在程序配置目录里）：
//! - cache.json：最近一次从主机拿到的数据，离线时显示它
//! - pending.json：还没传上去的改动
//! - rejected.json：主机明确拒绝的改动（不直接丢，需要时手工找回）

use serde_json::{json, Value};
use std::fs;
use std::io::Read;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use xp_core::Op;

fn base(url: &str) -> String {
    let u = url.trim().trim_end_matches('/');
    if u.starts_with("http://") || u.starts_with("https://") {
        u.to_string()
    } else {
        format!("http://{u}")
    }
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(4))
        .timeout(Duration::from_secs(15))
        .build()
}

/// 请求主机失败的三种情况
#[derive(Debug)]
pub enum RErr {
    /// 连不上主机（网络断了、主机没开）
    Offline(String),
    /// 主机在线但暂时存不了（比如数据盘没挂上），改动要留着稍后重试
    Busy(String),
    /// 主机明确拒绝（请求本身有问题），重试也没用
    Rejected(String),
}

impl RErr {
    fn retry(&self) -> bool {
        !matches!(self, RErr::Rejected(_))
    }
    pub fn msg(self) -> String {
        match self {
            RErr::Offline(m) | RErr::Busy(m) | RErr::Rejected(m) => m,
        }
    }
}

fn remote_err(base: &str, e: ureq::Error) -> RErr {
    match e {
        ureq::Error::Status(code, r) => {
            let m = r
                .into_json::<Value>()
                .ok()
                .and_then(|v| v.get("error").and_then(|x| x.as_str()).map(String::from))
                .unwrap_or_else(|| format!("主机 {base} 返回错误 {code}"));
            if code >= 500 || code == 408 || code == 429 {
                RErr::Busy(m)
            } else {
                RErr::Rejected(m)
            }
        }
        ureq::Error::Transport(t) => RErr::Offline(format!("连不上主机 {base}：{t}")),
    }
}

fn remote_get(url: &str, path: &str) -> Result<Value, RErr> {
    let b = base(url);
    agent()
        .get(&format!("{b}{path}"))
        .call()
        .map_err(|e| remote_err(&b, e))?
        .into_json::<Value>()
        .map_err(|e| RErr::Rejected(format!("主机 {b} 返回的数据不对：{e}")))
}

fn remote_apply(url: &str, op: &Op) -> Result<Value, RErr> {
    let b = base(url);
    let body = serde_json::to_string(op).map_err(|e| RErr::Rejected(e.to_string()))?;
    agent()
        .post(&format!("{b}/api/op"))
        .set("Content-Type", "text/plain; charset=utf-8")
        .send_string(&body)
        .map_err(|e| remote_err(&b, e))?
        .into_json::<Value>()
        // 主机可能已经存上了，只是回复没读全；操作可以重复执行，按暂时失败处理、稍后重发
        .map_err(|e| RErr::Busy(format!("主机 {b} 的回复读取失败：{e}")))
}

/// 调主机的 /api/v1，返回 {status, body}；HTTP 错误也照常返回（界面显示 body.error）
pub fn v1_raw(url: &str, method: &str, path: &str, body: Option<Value>) -> Result<Value, String> {
    let b = base(url);
    let mut req = agent()
        .request(method, &format!("{b}/api/v1{path}"))
        .set("X-Actor", "ui");
    if path.starts_with("/inbox/wechat/") {
        // 导入聊天记录可能有几十 MB
        req = req.timeout(Duration::from_secs(600));
    }
    let r = match body {
        Some(v) => req.send_json(v),
        None => req.call(),
    };
    let resp = match r {
        Ok(r) => r,
        Err(ureq::Error::Status(_, r)) => r,
        Err(ureq::Error::Transport(t)) => return Err(format!("连不上主机 {b}：{t}")),
    };
    let status = resp.status();
    // into_string 最多读 10MB，长的聊天记录导出会被截掉
    let mut text = String::new();
    std::io::Read::read_to_string(&mut resp.into_reader(), &mut text)
        .map_err(|e| format!("读取主机返回的内容失败：{e}"))?;
    let body = serde_json::from_str::<Value>(&text).unwrap_or_else(|_| json!(text));
    Ok(json!({ "status": status, "body": body }))
}

/// 同上，但 HTTP 错误转成 Err
pub fn v1(url: &str, method: &str, path: &str, body: Option<Value>) -> Result<Value, String> {
    let r = v1_raw(url, method, path, body)?;
    if r["status"].as_u64().unwrap_or(500) >= 400 {
        return Err(r["body"]["error"]
            .as_str()
            .unwrap_or("主机返回错误")
            .to_string());
    }
    Ok(r["body"].clone())
}

pub fn ping(url: &str) -> Result<(), String> {
    remote_get(url, "/api/ping").map(|_| ()).map_err(RErr::msg)
}

// ---- 本机缓存

fn read_json(p: &Path) -> Option<Value> {
    fs::read_to_string(p)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
}
fn cache_items(dir: &Path) -> Vec<Value> {
    read_json(&dir.join("cache.json"))
        .and_then(|v| v.get("items").cloned())
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
}
/// 缓存里除条目外的附带数据（设备、分类）
fn cache_extra(dir: &Path, key: &str) -> Value {
    read_json(&dir.join("cache.json"))
        .and_then(|v| v.get(key).cloned())
        .unwrap_or_else(|| json!([]))
}
/// 缓存状态；state 为 None 时只更新条目，设备和分类保留原来缓存的
fn save_cache(dir: &Path, items: &Value, state: Option<&Value>) {
    let pick = |k: &str| {
        state
            .and_then(|v| v.get(k).cloned())
            .unwrap_or_else(|| cache_extra(dir, k))
    };
    let body =
        json!({ "items": items, "devices": pick("devices"), "categories": pick("categories") });
    let _ = fs::write(dir.join("cache.json"), body.to_string());
}
fn pending(dir: &Path) -> Vec<Op> {
    read_json(&dir.join("pending.json"))
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}
fn save_pending(dir: &Path, ops: &[Op]) {
    let p = dir.join("pending.json");
    if ops.is_empty() {
        let _ = fs::remove_file(p);
    } else if let Ok(s) = serde_json::to_string(ops) {
        let _ = fs::write(p, s);
    }
}
fn save_rejected(dir: &Path, op: &Op, why: &str) {
    let p = dir.join("rejected.json");
    let mut list = match read_json(&p) {
        Some(Value::Array(a)) => a,
        _ => vec![],
    };
    let at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    list.push(json!({ "at": at, "error": why, "op": op }));
    if let Ok(s) = serde_json::to_string_pretty(&list) {
        let _ = fs::write(p, s);
    }
}
fn offline_state(dir: &Path, why: &str) -> Value {
    let n = pending(dir).len();
    json!({ "rev": format!("offline-{n}"), "items": cache_items(dir), "devices": cache_extra(dir, "devices"), "categories": cache_extra(dir, "categories"), "offline": true, "error": why, "pending": n })
}

/// 本地缓存上执行一个操作（和主机同样的规则：按 id 合并）
fn apply_local(items: &mut Vec<Value>, op: Op) {
    let id_of = xp_core::id_of;
    match op {
        Op::Upsert { item } => match id_of(&item).and_then(|id| {
            items
                .iter()
                .position(|x| id_of(x).as_deref() == Some(id.as_str()))
        }) {
            Some(p) => items[p] = item,
            None => items.push(item),
        },
        Op::Delete { id } => items.retain(|x| id_of(x).as_deref() != Some(id.as_str())),
        Op::Patch { id, set, unset, .. } => {
            if let Some(o) = items
                .iter_mut()
                .find(|x| id_of(x).as_deref() == Some(id.as_str()))
                .and_then(|x| x.as_object_mut())
            {
                for k in &unset {
                    o.remove(k);
                }
                o.extend(set);
            }
        }
        Op::Import { items: incoming } => {
            for it in incoming {
                let Some(id) = id_of(&it) else { continue };
                match items
                    .iter()
                    .position(|x| id_of(x).as_deref() == Some(id.as_str()))
                {
                    Some(p) if xp_core::updated_at(&it) >= xp_core::updated_at(&items[p]) => {
                        items[p] = it
                    }
                    Some(_) => {}
                    None => items.push(it),
                }
            }
        }
    }
}

/// 先把离线时记下的改动补传给主机，再取最新数据
pub fn state(dir: &Path, url: &str) -> Result<Value, String> {
    let mut ops = pending(dir);
    while !ops.is_empty() {
        match remote_apply(url, &ops[0]) {
            Ok(_) => {
                ops.remove(0);
                save_pending(dir, &ops);
            }
            // 连不上，或者主机暂时存不了：改动留在本机，下次再传
            Err(e) if e.retry() => return Ok(offline_state(dir, &e.msg())),
            Err(e) => {
                let m = e.msg();
                eprintln!("补传被主机拒绝，已另存到 rejected.json：{m}");
                save_rejected(dir, &ops[0], &m);
                ops.remove(0);
                save_pending(dir, &ops);
            }
        }
    }
    match remote_get(url, "/api/state") {
        Ok(v) => {
            save_cache(dir, &v["items"], Some(&v));
            Ok(v)
        }
        Err(e) if e.retry() => Ok(offline_state(dir, &e.msg())),
        Err(e) => Err(e.msg()),
    }
}

pub fn apply(dir: &Path, url: &str, op: Op) -> Result<Value, String> {
    xp_core::validate_op(&op)?;
    let why = if pending(dir).is_empty() {
        match remote_apply(url, &op) {
            Ok(v) => {
                save_cache(dir, &v["items"], Some(&v));
                return Ok(v);
            }
            Err(RErr::Rejected(e)) => return Err(e),
            Err(RErr::Offline(_)) => "连不上主机，改动先存在本机".to_string(),
            Err(RErr::Busy(e)) => format!("主机暂时存不了（{e}），改动先存在本机"),
        }
    } else {
        "还有改动没传上去，先存在本机".to_string()
    };
    let mut items = cache_items(dir);
    apply_local(&mut items, op.clone());
    save_cache(dir, &Value::Array(items), None);
    let mut ops = pending(dir);
    ops.push(op);
    save_pending(dir, &ops);
    Ok(offline_state(dir, &why))
}

pub fn rev(dir: &Path, url: &str) -> Result<String, String> {
    match remote_get(url, "/api/rev") {
        Ok(v) => {
            if !pending(dir).is_empty() {
                // 有待补传的改动：返回一个新值，让界面去取完整数据（顺便补传）
                let n = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0);
                return Ok(format!("flush-{n}"));
            }
            v.get("rev")
                .and_then(|x| x.as_str())
                .map(String::from)
                .ok_or_else(|| "主机返回的数据不对".into())
        }
        Err(e) if e.retry() => Ok(format!("offline-{}", pending(dir).len())),
        Err(e) => Err(e.msg()),
    }
}

// ---- 附件和界面

pub fn put_asset(url: &str, name: String, data: String) -> Result<String, String> {
    let b = base(url);
    let body = json!({ "name": name, "data": data }).to_string();
    let v: Value = agent()
        .post(&format!("{b}/api/asset"))
        .set("Content-Type", "text/plain; charset=utf-8")
        .send_string(&body)
        .map_err(|e| remote_err(&b, e).msg())?
        .into_json()
        .map_err(|e| e.to_string())?;
    v.get("name")
        .and_then(|x| x.as_str())
        .map(String::from)
        .ok_or_else(|| "上传失败".into())
}

pub fn get_asset(url: &str, name: &str) -> Result<Vec<u8>, String> {
    let b = base(url);
    let n = xp_store::safe_asset_name(name).map_err(|e| e.to_string())?;
    let mut buf = vec![];
    agent()
        .get(&format!("{b}/api/asset/{n}"))
        .call()
        .map_err(|e| remote_err(&b, e).msg())?
        .into_reader()
        .take(40_000_000)
        .read_to_end(&mut buf)
        .map_err(|e| e.to_string())?;
    Ok(buf)
}

pub fn ui(url: &str) -> Result<String, String> {
    let b = base(url);
    agent()
        .get(&format!("{b}/"))
        .call()
        .map_err(|e| remote_err(&b, e).msg())?
        .into_string()
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;
    use axum::response::IntoResponse;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use xp_store::Store;

    /// 起一个真的主机（xp-server）；busy 为 true 时 /api/op 回 503，模拟数据盘没挂上
    fn host(
        name: &str,
        busy: Arc<AtomicBool>,
    ) -> (String, std::path::PathBuf, tokio::runtime::Runtime) {
        let d = std::env::temp_dir().join(format!("xp-app-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        let st = Arc::new(Store::open(d.join("host")).unwrap());
        let rt = tokio::runtime::Runtime::new().unwrap();
        let l = xp_server::bind(0).unwrap();
        let port = l.local_addr().unwrap().port();
        let app = xp_server::router(st).layer(axum::middleware::from_fn(
            move |req: axum::extract::Request, next: axum::middleware::Next| {
                let busy = busy.clone();
                async move {
                    if busy.load(Ordering::SeqCst) && req.uri().path() == "/api/op" {
                        return (
                            StatusCode::SERVICE_UNAVAILABLE,
                            axum::Json(json!({"error":"无法访问数据文件夹"})),
                        )
                            .into_response();
                    }
                    next.run(req).await
                }
            },
        ));
        rt.spawn(async move {
            let l = tokio::net::TcpListener::from_std(l).unwrap();
            axum::serve(l, app).await.unwrap();
        });
        let cache = d.join("cache");
        fs::create_dir_all(&cache).unwrap();
        (format!("http://127.0.0.1:{port}"), cache, rt)
    }

    #[test]
    fn offline_queue_then_flush() {
        let busy = Arc::new(AtomicBool::new(false));
        let (url, cache, _rt) = host("flush", busy);
        // 主机没开：记进本机队列
        let dead = "http://127.0.0.1:9";
        let v = apply(
            &cache,
            dead,
            Op::Upsert {
                item: json!({"id":"x","title":"离线记的","updatedAt":5}),
            },
        )
        .unwrap();
        assert_eq!(v["offline"], true);
        assert_eq!(v["pending"], 1);
        assert_eq!(rev(&cache, dead).unwrap(), "offline-1");
        // 主机上线：取数据时自动补传
        assert!(rev(&cache, &url).unwrap().starts_with("flush-"));
        let v = state(&cache, &url).unwrap();
        assert!(v.get("offline").is_none());
        assert_eq!(v["items"][0]["title"], "离线记的");
        assert!(pending(&cache).is_empty());
    }

    /// 主机在线但暂时存不了：改动必须留着，恢复后补传，不能丢
    #[test]
    fn keeps_ops_while_host_cannot_save() {
        let busy = Arc::new(AtomicBool::new(true));
        let (url, cache, _rt) = host("busy", busy.clone());
        let v = apply(
            &cache,
            &url,
            Op::Upsert {
                item: json!({"id":"a","title":"硬盘没挂上时记的","updatedAt":1}),
            },
        )
        .unwrap();
        assert_eq!(v["offline"], true);
        assert_eq!(pending(&cache).len(), 1);
        let v = state(&cache, &url).unwrap();
        assert_eq!(v["offline"], true);
        assert_eq!(pending(&cache).len(), 1);
        busy.store(false, Ordering::SeqCst);
        let v = state(&cache, &url).unwrap();
        assert!(v.get("offline").is_none());
        assert_eq!(v["items"][0]["title"], "硬盘没挂上时记的");
        // 本机就能判断不合格的操作，直接报错
        assert!(apply(
            &cache,
            &url,
            Op::Upsert {
                item: json!({"title":"没有 id"})
            }
        )
        .is_err());
        // 队列里混进了会被主机拒绝的操作：挪到 rejected.json，后面的照常补传
        save_pending(
            &cache,
            &[
                Op::Upsert {
                    item: json!({"title":"没有 id"}),
                },
                Op::Upsert {
                    item: json!({"id":"b","title":"后面的","updatedAt":2}),
                },
            ],
        );
        let v = state(&cache, &url).unwrap();
        assert!(pending(&cache).is_empty());
        assert_eq!(v["items"].as_array().unwrap().len(), 2);
        assert_eq!(
            read_json(&cache.join("rejected.json"))
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }
}
