//! 设备：每台电脑（或 NAS、服务器）一条记录，存在数据库里，界面和接口都能维护。
//!
//! 条目的 `device` 字段存的是设备**名字**（和 v1 兼容，导出的 Markdown 也好读）；
//! 设备改名时存储层会把条目里的旧名字一起改掉。
//!
//! 设备字段（自由 JSON，下面这些有固定含义）：
//! - 手工维护：`name` `kind` `description` `aliases`（@ 提及和主机名匹配用）
//!   `networks`：[{name, ip, note}] 各个局域网里的地址
//!   `projects`：[{name, path, agent, note}] 这台电脑上的项目（消息分发的目标）
//! - 桌面版自动上报（心跳）：`hostname` `os` `reportedIps` `agentVersion` `aiTools` `isHost` `lastSeen`

use crate::{now_ms, str_of};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::net::IpAddr;

pub const DEVICE_KINDS: &[(&str, &str)] = &[
    ("desktop", "台式机"),
    ("laptop", "笔记本"),
    ("mac", "Mac"),
    ("server", "服务器"),
    ("nas", "NAS"),
    ("phone", "手机"),
    ("other", "其他"),
];

/// 多久没心跳算离线
pub const ONLINE_MS: f64 = 3.0 * 60_000.0;

/// 从旧版写死的名字猜类型
pub fn guess_kind(name: &str) -> &'static str {
    let n = name.to_lowercase();
    if n.contains("mac") {
        "mac"
    } else if n.contains("笔记本") || n.contains("laptop") {
        "laptop"
    } else if n.contains("台式") || n.contains("desktop") {
        "desktop"
    } else if n.contains("nas") {
        "nas"
    } else if n.contains("服务器") || n.contains("server") || n.contains("linux") {
        "server"
    } else {
        "other"
    }
}

fn check_name(v: &Value) -> Result<String, String> {
    let n = v.as_str().map(str::trim).unwrap_or("");
    if n.is_empty() {
        return Err("设备名不能为空".into());
    }
    if n.chars().count() > 40 || n.contains(char::is_whitespace) || n.contains(['@', '#']) {
        return Err("设备名不超过 40 个字，不能有空格、@ 和 #".into());
    }
    Ok(n.to_string())
}

fn check_ip(s: &str) -> Result<(), String> {
    if s.is_empty() || s.parse::<IpAddr>().is_ok() {
        Ok(())
    } else {
        Err(format!("IP 地址格式不对：{s}"))
    }
}

fn str_list(v: &Value, what: &str) -> Result<Vec<String>, String> {
    let a: Vec<String> =
        serde_json::from_value(v.clone()).map_err(|_| format!("{what} 要是字符串数组"))?;
    let mut out: Vec<String> = vec![];
    for s in a {
        let s = s.trim().to_string();
        if !s.is_empty() && !out.contains(&s) {
            out.push(s);
        }
    }
    Ok(out)
}

/// 规整一组对象（去空白、丢掉全空的行），并检查必填字段
fn rows(v: &Value, what: &str, keys: &[&str], required: &[&str]) -> Result<Vec<Value>, String> {
    let arr = v.as_array().ok_or_else(|| format!("{what} 要是数组"))?;
    let mut out = vec![];
    for (i, r) in arr.iter().enumerate() {
        let o = r
            .as_object()
            .ok_or_else(|| format!("{what} 第 {} 行格式不对", i + 1))?;
        let mut row = Map::new();
        for k in keys {
            let s = o
                .get(*k)
                .and_then(|x| x.as_str())
                .map(str::trim)
                .unwrap_or("");
            if !s.is_empty() {
                row.insert((*k).into(), json!(s));
            }
        }
        // 自动写入的字段原样保留（如 lastSeen）
        if let Some(t) = o.get("lastSeen").and_then(|x| x.as_f64()) {
            row.insert("lastSeen".into(), json!(t));
        }
        if keys.iter().all(|k| !row.contains_key(*k)) {
            continue;
        }
        for k in required {
            if !row.contains_key(*k) {
                return Err(format!("{what} 第 {} 行缺少 {k}", i + 1));
            }
        }
        out.push(Value::Object(row));
    }
    Ok(out)
}

/// 手工可改的字段；心跳字段不能手改
pub fn apply_device_patch(
    dev: &mut Value,
    patch: &Map<String, Value>,
    now: f64,
) -> Result<(), String> {
    let o = dev.as_object_mut().ok_or("设备数据损坏")?;
    for (k, v) in patch {
        match k.as_str() {
            "id" | "createdAt" | "updatedAt" | "deletedAt" | "lastSeen" | "hostname" | "os"
            | "reportedIps" | "agentVersion" | "aiTools" | "isHost" => continue,
            "name" => {
                o.insert(k.clone(), json!(check_name(v)?));
            }
            "kind" => {
                let s = v.as_str().unwrap_or("");
                if !DEVICE_KINDS.iter().any(|x| x.0 == s) {
                    return Err(format!(
                        "设备类型只能是：{}",
                        DEVICE_KINDS
                            .iter()
                            .map(|x| x.0)
                            .collect::<Vec<_>>()
                            .join(" / ")
                    ));
                }
                o.insert(k.clone(), json!(s));
            }
            "description" => {
                o.insert(k.clone(), json!(v.as_str().unwrap_or("").trim()));
            }
            "aliases" => {
                o.insert(k.clone(), json!(str_list(v, "aliases")?));
            }
            "networks" => {
                let r = rows(v, "局域网地址", &["name", "ip", "note"], &["name"])?;
                for x in &r {
                    check_ip(str_of(x, "ip"))?;
                }
                o.insert(k.clone(), Value::Array(r));
            }
            "projects" => {
                o.insert(
                    k.clone(),
                    Value::Array(rows(
                        v,
                        "项目",
                        &["name", "path", "agent", "note"],
                        &["name", "path"],
                    )?),
                );
            }
            "sort" => {
                o.insert(k.clone(), json!(v.as_f64().ok_or("sort 要是数字")?));
            }
            _ if v.is_null() => {
                o.remove(k);
            }
            _ => {
                o.insert(k.clone(), v.clone());
            }
        }
    }
    o.insert("updatedAt".into(), json!(now));
    Ok(())
}

/// 新建设备（手工或第一次心跳时）
pub fn new_device(id: &str, input: &Map<String, Value>, now: f64) -> Result<Value, String> {
    let mut d = json!({ "id": id, "name": "", "kind": "other", "description": "", "aliases": [], "networks": [], "projects": [], "createdAt": now });
    if !input.contains_key("name") {
        return Err("设备名不能为空".into());
    }
    let mut input = input.clone();
    if !input.contains_key("kind") {
        let k = guess_kind(input.get("name").and_then(|v| v.as_str()).unwrap_or(""));
        input.insert("kind".into(), json!(k));
    }
    apply_device_patch(&mut d, &input, now)?;
    Ok(d)
}

/// 桌面版每分钟上报一次
#[derive(Deserialize, Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Heartbeat {
    pub id: String,
    pub hostname: String,
    pub os: String,
    /// [{ip, iface}]
    pub ips: Vec<Value>,
    pub agent_version: String,
    pub ai_tools: Vec<String>,
    pub is_host: bool,
}

fn same_subnet(a: &str, b: &str) -> bool {
    match (a.parse::<IpAddr>(), b.parse::<IpAddr>()) {
        (Ok(IpAddr::V4(a)), Ok(IpAddr::V4(b))) => a.octets()[..3] == b.octets()[..3],
        _ => false,
    }
}

/// 把心跳写进设备记录；返回是否有“值得通知界面”的变化（在线状态或上报内容变了）
pub fn apply_heartbeat(dev: &mut Value, hb: &Heartbeat, now: f64) -> bool {
    let before = dev.clone();
    let was_online = dev
        .get("lastSeen")
        .and_then(|x| x.as_f64())
        .map(|t| now - t < ONLINE_MS)
        .unwrap_or(false);
    let Some(o) = dev.as_object_mut() else {
        return false;
    };
    let ips: Vec<Value> = hb
        .ips
        .iter()
        .filter(|v| {
            v.get("ip")
                .and_then(|x| x.as_str())
                .map(|s| s.parse::<IpAddr>().is_ok())
                .unwrap_or(false)
        })
        .cloned()
        .collect();
    o.insert("hostname".into(), json!(hb.hostname));
    o.insert("os".into(), json!(hb.os));
    o.insert("reportedIps".into(), Value::Array(ips.clone()));
    o.insert("agentVersion".into(), json!(hb.agent_version));
    o.insert("aiTools".into(), json!(hb.ai_tools));
    o.insert("isHost".into(), json!(hb.is_host));
    // 已登记的局域网里，如果上报的地址在同一网段，就更新成当前地址
    if let Some(nets) = o.get_mut("networks").and_then(|v| v.as_array_mut()) {
        for n in nets.iter_mut() {
            let cur = str_of(n, "ip").to_string();
            if let Some(ip) = ips
                .iter()
                .filter_map(|x| x.get("ip").and_then(|v| v.as_str()))
                .find(|ip| same_subnet(ip, &cur))
            {
                if let Some(no) = n.as_object_mut() {
                    no.insert("ip".into(), json!(ip));
                    no.insert("lastSeen".into(), json!(now));
                }
            }
        }
    }
    let mut cmp_before = before;
    let mut cmp_after = Value::Object(o.clone());
    for v in [&mut cmp_before, &mut cmp_after] {
        if let Some(m) = v.as_object_mut() {
            m.remove("lastSeen");
            if let Some(nets) = m.get_mut("networks").and_then(|x| x.as_array_mut()) {
                for n in nets {
                    if let Some(no) = n.as_object_mut() {
                        no.remove("lastSeen");
                    }
                }
            }
        }
    }
    o.insert("lastSeen".into(), json!(now));
    !was_online || cmp_before != cmp_after
}

/// 当前时间下是否在线
pub fn is_online(dev: &Value) -> bool {
    dev.get("lastSeen")
        .and_then(|x| x.as_f64())
        .map(|t| now_ms() - t < ONLINE_MS)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn create_and_validate() {
        let d = new_device("d1", &m(json!({"name":"笔记本"})), 1.0).unwrap();
        assert_eq!(d["kind"], "laptop");
        assert!(new_device("x", &m(json!({})), 1.0).is_err());
        assert!(new_device("x", &m(json!({"name":"有 空格"})), 1.0).is_err());
        let mut d = new_device("d2", &m(json!({"name":"BASE","kind":"desktop"})), 1.0).unwrap();
        let p = m(json!({
            "description":"8TB 盘在这台",
            "aliases":["base"," base ","台式机"],
            "networks":[{"name":"家里","ip":"192.168.1.20"},{"name":"","ip":""}],
            "projects":[{"name":"xpanel","path":"D:\\codes\\workbench-app","agent":"Claude Code"}],
            "hostname":"手改无效"
        }));
        apply_device_patch(&mut d, &p, 2.0).unwrap();
        assert_eq!(d["aliases"], json!(["base", "台式机"]));
        assert_eq!(d["networks"].as_array().unwrap().len(), 1);
        assert!(d.get("hostname").is_none());
        assert!(apply_device_patch(
            &mut d,
            &m(json!({"networks":[{"name":"x","ip":"999.1.1.1"}]})),
            3.0
        )
        .is_err());
        assert!(
            apply_device_patch(&mut d, &m(json!({"projects":[{"name":"只有名字"}]})), 3.0).is_err()
        );
        assert!(apply_device_patch(&mut d, &m(json!({"kind":"toaster"})), 3.0).is_err());
    }

    #[test]
    fn heartbeat_updates_ip_in_known_network() {
        let mut d = new_device("d", &m(json!({"name":"笔记本","networks":[{"name":"家里","ip":"192.168.1.20"},{"name":"公司","ip":"10.0.8.5"}]})), 1.0).unwrap();
        let hb = Heartbeat {
            id: "d".into(),
            hostname: "GLWINHONOR".into(),
            os: "windows".into(),
            ips: vec![
                json!({"ip":"192.168.1.37","iface":"WLAN"}),
                json!({"ip":"bad"}),
            ],
            ..Default::default()
        };
        assert!(apply_heartbeat(&mut d, &hb, 1_000_000.0));
        assert_eq!(d["networks"][0]["ip"], "192.168.1.37");
        assert_eq!(d["networks"][1]["ip"], "10.0.8.5");
        assert_eq!(d["reportedIps"].as_array().unwrap().len(), 1);
        assert_eq!(d["hostname"], "GLWINHONOR");
        // 一分钟后同样的心跳：只更新 lastSeen，不算变化
        assert!(!apply_heartbeat(&mut d, &hb, 1_060_000.0));
        assert_eq!(d["lastSeen"], 1_060_000.0);
        // 离线很久后再上线：算变化（界面要刷新在线状态）
        assert!(apply_heartbeat(&mut d, &hb, 9_000_000.0));
    }
}
