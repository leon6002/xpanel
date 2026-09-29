//! 这台电脑作为一个设备：每分钟向主机上报一次（主机名、系统、IP、版本、装了哪些 AI 命令行），
//! 以及给界面用的通用 /api/v1 调用（主机模式在本进程里处理，连接模式转发给主机）。

use crate::{client, AppState, Config};
use serde_json::{json, Value};
use std::net::IpAddr;
use xp_core::device::Heartbeat;

/// 虚拟网卡和代理网卡的地址对“在哪个局域网”没有意义，不上报
fn skip_iface(name: &str, ip: &IpAddr) -> bool {
    let n = name.to_lowercase();
    let virt = [
        "vethernet",
        "vmware",
        "virtualbox",
        "docker",
        "wsl",
        "loopback",
        "hyper-v",
        "tailscale",
        "zerotier",
        "utun",
        "tun",
        "tap",
        "clash",
        "meta",
    ];
    if virt.iter().any(|v| n.contains(v)) {
        return true;
    }
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            v4.is_loopback() || v4.is_link_local() || (o[0] == 198 && (o[1] == 18 || o[1] == 19))
            // Clash fake-ip
        }
        IpAddr::V6(_) => true,
    }
}

pub fn local_ips() -> Vec<Value> {
    let Ok(ifs) = if_addrs::get_if_addrs() else {
        return vec![];
    };
    let mut out: Vec<Value> = vec![];
    for i in ifs {
        let ip = i.ip();
        if skip_iface(&i.name, &ip) {
            continue;
        }
        let ip = ip.to_string();
        if !out.iter().any(|v| v["ip"] == json!(ip)) {
            out.push(json!({ "ip": ip, "iface": i.name }));
        }
    }
    out
}

fn in_path(name: &str) -> bool {
    let exts: &[&str] = if cfg!(windows) {
        &[".exe", ".cmd", ".bat", ".ps1"]
    } else {
        &[""]
    };
    std::env::var_os("PATH")
        .map(|p| {
            std::env::split_paths(&p)
                .any(|d| exts.iter().any(|e| d.join(format!("{name}{e}")).is_file()))
        })
        .unwrap_or(false)
}

/// 本机装了哪些 AI 命令行（常见的几个 + 设置里配置的命令）
pub fn ai_tools(cfg: &Config) -> Vec<String> {
    let mut names: Vec<String> = ["claude", "codex", "dsh", "gemini", "aider"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    for a in &cfg.agents {
        let c = a.cmd.trim();
        if c.starts_with("http") {
            continue;
        }
        if let Some(first) = c.split_whitespace().next() {
            if !names.iter().any(|n| n == first) {
                names.push(first.to_string());
            }
        }
    }
    names.into_iter().filter(|n| in_path(n)).collect()
}

pub fn hostname() -> String {
    gethostname::gethostname().to_string_lossy().to_string()
}

pub fn heartbeat_of(cfg: &Config) -> Heartbeat {
    Heartbeat {
        id: cfg.device_id.clone(),
        hostname: hostname(),
        os: format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
        ips: local_ips(),
        agent_version: env!("CARGO_PKG_VERSION").into(),
        ai_tools: ai_tools(cfg),
        is_host: cfg.mode == "host",
    }
}

/// 上报一次心跳；还没选“这台电脑是哪个设备”时不报
pub fn send_heartbeat(st: &AppState) -> Result<(), String> {
    let cfg = st.cfg();
    if cfg.device_id.is_empty() {
        return Ok(());
    }
    let hb = heartbeat_of(&cfg);
    match cfg.mode.as_str() {
        "host" => st
            .host_store()?
            .heartbeat(&hb)
            .map(|_| ())
            .map_err(|e| e.to_string()),
        "client" => {
            let body = serde_json::to_value(&hb).map_err(|e| e.to_string())?;
            client::v1(&cfg.server_url, "POST", "/devices/heartbeat", Some(body)).map(|_| ())
        }
        _ => Ok(()),
    }
}

/// 界面调用 /api/v1：返回 {status, body}。主机模式直接交给本进程里的路由处理，连接模式转发给主机。
pub async fn api_call(
    st: std::sync::Arc<AppState>,
    method: String,
    path: String,
    body: Option<Value>,
) -> Result<Value, String> {
    if !path.starts_with('/') || path.contains("..") {
        return Err("接口路径不对".into());
    }
    let cfg = st.cfg();
    match cfg.mode.as_str() {
        "host" => {
            use http_body_util::BodyExt;
            use tower::ServiceExt;
            let st2 = st.clone();
            let store = tauri::async_runtime::spawn_blocking(move || st2.host_store())
                .await
                .map_err(|e| e.to_string())??;
            let req = axum::http::Request::builder()
                .method(method.as_str())
                .uri(format!("/api/v1{path}"))
                .header("content-type", "application/json")
                .header("x-actor", "ui")
                .body(axum::body::Body::from(
                    body.map(|b| b.to_string()).unwrap_or_default(),
                ))
                .map_err(|e| e.to_string())?;
            let resp = xp_server::router(store)
                .oneshot(req)
                .await
                .map_err(|e| e.to_string())?;
            let status = resp.status().as_u16();
            let bytes = resp
                .into_body()
                .collect()
                .await
                .map_err(|e| e.to_string())?
                .to_bytes();
            let body = serde_json::from_slice::<Value>(&bytes)
                .unwrap_or_else(|_| json!(String::from_utf8_lossy(&bytes)));
            Ok(json!({ "status": status, "body": body }))
        }
        "client" => {
            let url = cfg.server_url.clone();
            tauri::async_runtime::spawn_blocking(move || client::v1_raw(&url, &method, &path, body))
                .await
                .map_err(|e| e.to_string())?
        }
        _ => Err("还没有设置".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_virtual_and_proxy_addresses() {
        assert!(skip_iface(
            "vEthernet (WSL)",
            &"172.20.0.1".parse().unwrap()
        ));
        assert!(skip_iface("Clash", &"198.18.0.1".parse().unwrap()));
        assert!(skip_iface("以太网", &"198.18.0.50".parse().unwrap()));
        assert!(skip_iface("lo", &"127.0.0.1".parse().unwrap()));
        assert!(!skip_iface("以太网", &"192.168.1.20".parse().unwrap()));
        assert!(!skip_iface("WLAN", &"10.0.8.5".parse().unwrap()));
    }
}
