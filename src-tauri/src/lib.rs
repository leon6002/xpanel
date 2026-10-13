//! xpanel 桌面版
//! - 主机模式：数据存在本机数据文件夹（xp-store / SQLite），同时在局域网开网页服务和对外接口（xp-server）
//! - 连接模式：数据读写主机（http://主机名:端口），连不上时存在本机，恢复后自动补传（client.rs）
//!
//! 界面仍是 ui/index.html，命令名和返回格式与 v1 保持一致。

mod agent;
mod client;
mod device;
mod live;
mod runs;
mod shortcut;
mod workspace;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::net::UdpSocket;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;
use xp_core::Op;
use xp_store::{legacy_rev, Store, ACTOR_UI};

pub use agent::Agent;

/// 旧版（Workbench）的配置目录名，第一次启动时把设置和离线队列搬过来
const OLD_IDENTIFIER: &str = "io.github.workbench.panel";

// ---------------------------------------------------------------- 配置

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    /// "host" = 这台电脑存数据；"client" = 连接到别的电脑；"" = 还没设置
    pub mode: String,
    pub data_dir: String,
    pub server_url: String,
    /// 连接模式：主机打开了「局域网访问要令牌」时填的令牌
    pub server_token: String,
    pub port: u16,
    pub lan_enabled: bool,
    /// 可以把条目交给的 AI；cmd 里用 {prompt} 代表提示词
    pub agents: Vec<Agent>,
    /// 启动 AI 时默认进入的文件夹
    pub agent_cwd: String,
    /// 冷备份文件夹（比如 8TB 盘），每天自动复制一份过去。界面不传这个字段时保留原值
    pub cold_backup_dir: Option<String>,
    /// 这台电脑在设备表里的 id；空 = 还没选。界面不传这个字段时保留原值
    pub device_id: String,
    /// 外置硬盘上的文件夹（比如 F:\xpanel），一键备份和合并用。界面不传这个字段时保留原值
    pub sync_dir: String,
    /// 已经从旧的默认端口 8765 挪到新的默认端口（旧配置里没有这个字段 = false）
    #[serde(default)]
    pub port_moved: bool,
}

/// 以前的默认端口
const OLD_PORT: u16 = 8765;

impl Config {
    /// 旧的默认端口 8765 挪到新的默认端口：主机的端口、连接模式填的主机地址都换掉。只做一次
    fn move_old_port(&mut self) -> bool {
        if self.port_moved {
            return false;
        }
        self.port_moved = true;
        if self.port == OLD_PORT {
            self.port = xp_server::DEFAULT_PORT;
        }
        let old = format!(":{OLD_PORT}");
        let url = self.server_url.trim().trim_end_matches('/');
        if let Some(head) = url.strip_suffix(&old) {
            self.server_url = format!("{head}:{}", xp_server::DEFAULT_PORT);
        }
        true
    }
}

impl Default for Config {
    fn default() -> Self {
        Config {
            mode: String::new(),
            data_dir: default_dir(),
            server_url: String::new(),
            server_token: String::new(),
            port: xp_server::DEFAULT_PORT,
            lan_enabled: true,
            agents: agent::default_agents(),
            agent_cwd: String::new(),
            cold_backup_dir: None,
            device_id: String::new(),
            sync_dir: String::new(),
            port_moved: true,
        }
    }
}

fn default_dir() -> String {
    if cfg!(windows) {
        r"D:\xpanel".into()
    } else {
        format!(
            "{}/xpanel",
            std::env::var("HOME").unwrap_or_else(|_| ".".into())
        )
    }
}

pub struct AppState {
    cfg: Mutex<Config>,
    cfg_path: PathBuf,
    cache_dir: PathBuf,
    store: Mutex<Option<Arc<Store>>>,
    lan: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
}

impl AppState {
    fn cfg(&self) -> Config {
        self.cfg.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// 主机模式的数据库；数据文件夹变了就重新打开
    fn host_store(&self) -> Result<Arc<Store>, String> {
        let cfg = self.cfg();
        let mut cur = self.store.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(s) = cur.as_ref() {
            if s.dir() == std::path::Path::new(&cfg.data_dir) {
                return Ok(s.clone());
            }
        }
        let s = Arc::new(Store::open(&cfg.data_dir).map_err(|e| e.to_string())?);
        s.set_cold_backup_dir(cfg.cold_backup_dir.clone().map(PathBuf::from));
        s.set_drive_dir(Some(PathBuf::from(&cfg.sync_dir)));
        // 合并时显示「在哪台电脑改的」：用这台电脑在设备表里的名字
        if let Ok(d) = s.get_device(&cfg.device_id) {
            let _ = s.set_replica_name(d["name"].as_str().unwrap_or(""));
        }
        *cur = Some(s.clone());
        Ok(s)
    }
}

// ---------------------------------------------------------------- 局域网服务

fn stop_lan(st: &AppState) {
    if let Some(tx) = st.lan.lock().unwrap_or_else(|e| e.into_inner()).take() {
        let _ = tx.send(());
    }
}

fn start_lan(st: &Arc<AppState>, app: &AppHandle) -> Result<(), String> {
    stop_lan(st);
    let cfg = st.cfg();
    if cfg.mode != "host" || !cfg.lan_enabled {
        return Ok(());
    }
    let store = st.host_store()?;
    // 端口刚释放时可能还占着，稍等重试
    let mut last = String::new();
    let mut listener = None;
    for _ in 0..10 {
        match xp_server::bind(cfg.port) {
            Ok(l) => {
                listener = Some(l);
                break;
            }
            Err(e) => {
                last = e;
                std::thread::sleep(Duration::from_millis(200));
            }
        }
    }
    let listener = listener.ok_or(last)?;
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    // 局域网里带令牌的可以叫这台电脑上的 AI（主机设置里打开才行，见 xp-server 的 remote.rs）
    let agents: Arc<dyn xp_server::AgentHost> = Arc::new(HostAgents {
        st: st.clone(),
        app: app.clone(),
    });
    tauri::async_runtime::spawn(async move {
        if let Err(e) = xp_server::serve_with(store, listener, Some(agents), async {
            let _ = rx.await;
        })
        .await
        {
            eprintln!("局域网服务出错：{e}");
        }
    });
    *st.lan.lock().unwrap_or_else(|e| e.into_inner()) = Some(tx);
    Ok(())
}

fn local_ips() -> Vec<String> {
    let mut out = vec![];
    for target in ["192.168.1.1:80", "8.8.8.8:80"] {
        if let Ok(sock) = UdpSocket::bind("0.0.0.0:0") {
            if sock.connect(target).is_ok() {
                if let Ok(a) = sock.local_addr() {
                    let ip = a.ip().to_string();
                    if !ip.starts_with("0.") && !ip.starts_with("127.") && !out.contains(&ip) {
                        out.push(ip);
                    }
                }
            }
        }
    }
    out
}

fn lan_info_of(st: &AppState) -> Value {
    let cfg = st.cfg();
    let running = st.lan.lock().map(|g| g.is_some()).unwrap_or(false);
    let host = gethostname::gethostname().to_string_lossy().to_string();
    let mut urls = vec![format!("http://{host}:{}", cfg.port)];
    for ip in local_ips() {
        urls.push(format!("http://{ip}:{}", cfg.port));
    }
    json!({ "running": running, "hostname": host, "urls": urls, "port": cfg.port })
}

// ---------------------------------------------------------------- 给界面用的命令

type St<'a> = State<'a, Arc<AppState>>;

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

fn not_set<T>() -> Result<T, String> {
    Err("还没有设置".into())
}

#[tauri::command]
async fn get_config(s: St<'_>) -> Result<Value, String> {
    let st = s.inner().clone();
    Ok(json!({ "config": st.cfg(), "lan": lan_info_of(&st), "hostname": device::hostname() }))
}

fn write_config(st: &AppState, cfg: &Config) -> Result<(), String> {
    let body = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    fs::write(&st.cfg_path, body).map_err(|e| format!("保存设置失败：{e}"))?;
    *st.cfg.lock().unwrap_or_else(|e| e.into_inner()) = cfg.clone();
    Ok(())
}

/// 后台发一次心跳（不等结果，连不上也没关系）
fn heartbeat_soon(st: &Arc<AppState>) {
    let st = st.clone();
    std::thread::spawn(move || {
        let _ = device::send_heartbeat(&st);
    });
}

/// 设定“这台电脑是哪个设备”
#[tauri::command]
async fn set_this_device(s: St<'_>, id: String) -> Result<Value, String> {
    let st = s.inner().clone();
    blocking(move || {
        let mut cfg = st.cfg();
        cfg.device_id = id.trim().to_string();
        write_config(&st, &cfg)?;
        device::send_heartbeat(&st)?;
        // 合并时显示的「在哪台电脑改的」跟着换
        if cfg.mode == "host" {
            let s = st.host_store()?;
            if let Ok(d) = s.get_device(&cfg.device_id) {
                let _ = s.set_replica_name(d["name"].as_str().unwrap_or(""));
            }
        }
        Ok(json!({ "config": st.cfg() }))
    })
    .await
}

/// 界面调用 /api/v1（设备管理等）：主机模式在本进程处理，连接模式转发给主机
#[tauri::command]
async fn api_call(
    s: St<'_>,
    method: String,
    path: String,
    body: Option<Value>,
) -> Result<Value, String> {
    device::api_call(s.inner().clone(), method, path, body).await
}

#[tauri::command]
async fn save_config(app: AppHandle, s: St<'_>, cfg: Config) -> Result<Value, String> {
    let st = s.inner().clone();
    blocking(move || {
        let mut cfg = cfg;
        // 界面不传这个字段；之后改回 8765 也是用户自己选的，不再挪
        cfg.port_moved = true;
        if cfg.device_id.is_empty() {
            cfg.device_id = st.cfg().device_id;
        }
        if cfg.sync_dir.is_empty() {
            cfg.sync_dir = st.cfg().sync_dir;
        }
        if cfg.cold_backup_dir.is_none() {
            cfg.cold_backup_dir = st.cfg().cold_backup_dir;
        }
        cfg.cold_backup_dir = cfg
            .cold_backup_dir
            .map(|d| d.trim().to_string())
            .filter(|d| !d.is_empty());
        if cfg.mode == "host" {
            Store::open(&cfg.data_dir).map_err(|e| e.to_string())?;
        }
        if cfg.mode == "client" {
            cfg.server_token = cfg.server_token.trim().to_string();
            let old = st.cfg().server_token;
            client::set_token(&cfg.server_token);
            if let Err(e) = client::ping(&cfg.server_url) {
                client::set_token(&old);
                return Err(e);
            }
        }
        write_config(&st, &cfg)?;
        // 数据文件夹或冷备份位置可能变了：重新打开数据库
        *st.store.lock().unwrap_or_else(|e| e.into_inner()) = None;
        let lan_err = start_lan(&st, &app).err();
        heartbeat_soon(&st);
        Ok(json!({ "config": st.cfg(), "lan": lan_info_of(&st), "lanError": lan_err }))
    })
    .await
}

#[tauri::command]
async fn get_state(s: St<'_>) -> Result<Value, String> {
    let st = s.inner().clone();
    blocking(move || match st.cfg().mode.as_str() {
        "host" => st.host_store()?.legacy_state().map_err(|e| e.to_string()),
        "client" => client::state(&st.cache_dir, &st.cfg().server_url),
        _ => not_set(),
    })
    .await
}

#[tauri::command]
async fn get_rev(s: St<'_>) -> Result<String, String> {
    let st = s.inner().clone();
    blocking(move || match st.cfg().mode.as_str() {
        "host" => st
            .host_store()?
            .rev()
            .map(legacy_rev)
            .map_err(|e| e.to_string()),
        "client" => client::rev(&st.cache_dir, &st.cfg().server_url),
        _ => not_set(),
    })
    .await
}

#[tauri::command]
async fn apply_op(s: St<'_>, op: Op) -> Result<Value, String> {
    let st = s.inner().clone();
    blocking(move || match st.cfg().mode.as_str() {
        "host" => {
            let store = st.host_store()?;
            store.apply_op(op, ACTOR_UI).map_err(|e| e.to_string())?;
            store.legacy_state().map_err(|e| e.to_string())
        }
        "client" => client::apply(&st.cache_dir, &st.cfg().server_url, op),
        _ => not_set(),
    })
    .await
}

/// 打开网址、文件夹或文件（在这台电脑上打开）
#[tauri::command]
async fn open_target(app: AppHandle, target: String) -> Result<(), String> {
    let t = target.trim().to_string();
    let lower = t.to_lowercase();
    let r = if lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("smb://")
    {
        app.opener().open_url(t, None::<&str>)
    } else {
        let p = t
            .strip_prefix("file:")
            .map(|x| x.trim_start_matches('/').to_string());
        let p = match p {
            // file://HOST/share -> \\HOST\share
            Some(rest) if cfg!(windows) && !rest.contains(':') => {
                format!(r"\\{}", rest.replace('/', "\\"))
            }
            Some(rest) => rest,
            None => t,
        };
        app.opener().open_path(p, None::<&str>)
    };
    r.map_err(|e| format!("打不开：{e}"))
}

#[tauri::command]
async fn open_data_dir(app: AppHandle, s: St<'_>) -> Result<(), String> {
    let dir = s.inner().cfg().data_dir;
    app.opener()
        .open_path(dir, None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn put_asset(s: St<'_>, name: String, data: String) -> Result<String, String> {
    let st = s.inner().clone();
    blocking(move || match st.cfg().mode.as_str() {
        "host" => {
            use base64::Engine;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(data.as_bytes())
                .map_err(|e| e.to_string())?;
            st.host_store()?
                .put_asset(&name, &bytes)
                .map_err(|e| e.to_string())
        }
        "client" => client::put_asset(&st.cfg().server_url, name, data),
        _ => not_set(),
    })
    .await
}

/// 回答后台 AI 的一个确认请求：allow（这一次）、kind（以后同类的都允许）、all（这次任务都允许）、deny
#[tauri::command]
fn ai_decide(run: String, id: String, decision: String) -> Result<(), String> {
    runs::decide(&run, &id, &decision)
}

/// 停止一次后台的 AI 任务
#[tauri::command]
fn ai_stop(run: String) {
    runs::stop(&run)
}

/// 把界面生成的文件（比如导出的上下文压缩包）存到「下载」文件夹，返回存到了哪。重名的在后面加序号，不覆盖
#[tauri::command]
async fn save_download(app: AppHandle, name: String, data: String) -> Result<String, String> {
    let dir = app
        .path()
        .download_dir()
        .or_else(|_| app.path().home_dir())
        .map_err(|e| format!("找不到下载文件夹：{e}"))?;
    blocking(move || {
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data.as_bytes())
            .map_err(|e| e.to_string())?;
        // 文件名里只留安全的字符，不让它带路径
        let clean: String = name
            .chars()
            .map(|c| {
                if c.is_control() || "\\/:*?\"<>|".contains(c) {
                    '_'
                } else {
                    c
                }
            })
            .collect();
        let clean = clean.trim().trim_matches('.').to_string();
        let clean = if clean.is_empty() {
            "xpanel-export".to_string()
        } else {
            clean
        };
        let (stem, ext) = match clean.rsplit_once('.') {
            Some((a, b)) if !a.is_empty() => (a.to_string(), format!(".{b}")),
            _ => (clean.clone(), String::new()),
        };
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let mut path = dir.join(&clean);
        let mut n = 2;
        while path.exists() {
            path = dir.join(format!("{stem} ({n}){ext}"));
            n += 1;
        }
        std::fs::write(&path, bytes).map_err(|e| format!("保存失败：{e}"))?;
        Ok(path.to_string_lossy().to_string())
    })
    .await
}

/// 读一个附件的内容：主机模式读本地数据库，连接模式向主机要
fn asset_bytes(st: &AppState, name: &str) -> Result<Vec<u8>, String> {
    match st.cfg().mode.as_str() {
        "host" => st.host_store()?.get_asset(name).map_err(|e| e.to_string()),
        "client" => client::get_asset(&st.cfg().server_url, name),
        _ => not_set(),
    }
}

/// 设置外置硬盘上的文件夹（一键备份、从外置硬盘合并用），记到配置里。
/// 备份和合并本身走 /api/v1/backup（`api_call`），浏览器里也能用
#[tauri::command]
async fn set_sync_dir(s: St<'_>, dir: String) -> Result<Value, String> {
    let st = s.inner().clone();
    blocking(move || {
        if st.cfg().mode != "host" {
            return Err("连接模式的数据在主机上，请在主机上设置外置硬盘的文件夹".into());
        }
        let dir = dir.trim().to_string();
        let mut cfg = st.cfg();
        if cfg.sync_dir != dir {
            cfg.sync_dir = dir.clone();
            write_config(&st, &cfg)?;
        }
        st.host_store()?.set_drive_dir(Some(PathBuf::from(dir)));
        Ok(json!({ "config": st.cfg() }))
    })
    .await
}

/// 返回 data: 网址，界面直接当图片用
#[tauri::command]
async fn get_asset(s: St<'_>, name: String) -> Result<String, String> {
    let st = s.inner().clone();
    blocking(move || {
        use base64::Engine;
        let bytes = asset_bytes(&st, &name)?;
        Ok(format!(
            "data:{};base64,{}",
            xp_store::mime_of(&name),
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ))
    })
    .await
}

/// 返回可用的最新界面：主机读数据文件夹，连接模式向主机要
#[tauri::command]
async fn get_ui_override(s: St<'_>) -> Result<String, String> {
    let st = s.inner().clone();
    blocking(move || match st.cfg().mode.as_str() {
        "host" => Ok(xp_server::best_ui(std::path::Path::new(&st.cfg().data_dir))),
        "client" => client::ui(&st.cfg().server_url),
        _ => Ok(xp_server::UI_HTML.to_string()),
    })
    .await
}

#[tauri::command]
async fn run_agent(
    app: AppHandle,
    agent: Agent,
    cwd: String,
    prompt: String,
) -> Result<(), String> {
    let cmd = agent.cmd.trim();
    if cmd.is_empty() {
        return Err("这个 AI 还没有填命令".into());
    }
    if cmd.starts_with("http://") || cmd.starts_with("https://") {
        let url = cmd.replace("{prompt}", &agent::pct_encode(&prompt));
        return app
            .opener()
            .open_url(url, None::<&str>)
            .map_err(|e| e.to_string());
    }
    blocking(move || agent::launch_terminal(&agent, &cwd, &prompt)).await
}

/// AI 通过 MCP 连工作台用的：xp 命令在哪、工作台的地址。主机模式要开着局域网服务才有地址；找不到 xp 就不接
fn mcp_link(cfg: &Config, actor: &str) -> Option<agent::McpLink> {
    let url = match cfg.mode.as_str() {
        "host" if cfg.lan_enabled => format!("http://127.0.0.1:{}", cfg.port),
        "client" if !cfg.server_url.trim().is_empty() => {
            cfg.server_url.trim().trim_end_matches('/').to_string()
        }
        _ => return None,
    };
    let name = if cfg!(windows) { "xp.exe" } else { "xp" };
    let beside = std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(|d| d.join(name)))
        .filter(|f| f.is_file());
    let xp = beside.or_else(|| {
        std::env::var_os("PATH").and_then(|p| {
            std::env::split_paths(&p)
                .map(|d| d.join(name))
                .find(|f| f.is_file())
        })
    })?;
    Some(agent::McpLink {
        xp,
        url,
        actor: actor.trim().to_string(),
        // 主机本机走 127.0.0.1 不用令牌；连接模式连主机要带
        token: if cfg.mode == "client" {
            cfg.server_token.trim().to_string()
        } else {
            String::new()
        },
    })
}

/// 问 AI 一个问题（不开窗口），返回回答。cwd 是笔记展开的项目目录时，AI 能看到里面的材料。
/// images 是笔记和关联条目里的图片、附件（附件名）：先写到工作目录的 `.xpanel/ask-files/` 里，提示词里写的就是这些相对路径，
/// AI 用读文件的工具就能看到内容（图片 codex 另外用 -i 直接附上）。
#[tauri::command]
#[allow(clippy::too_many_arguments)] // 参数和界面传来的字段一一对应
async fn ask_ai(
    app: AppHandle,
    s: St<'_>,
    agent: Agent,
    cwd: String,
    prompt: String,
    images: Option<Vec<String>>,
    key: Option<String>,
    run: Option<String>,
    resume: Option<String>,
) -> Result<agent::Answer, String> {
    let st = s.inner().clone();
    let req = xp_server::AskReq {
        agent: agent.name.clone(),
        cwd,
        prompt,
        images: images.unwrap_or_default(),
        key: key.unwrap_or_default(),
        run: run.unwrap_or_default(),
        resume,
    };
    blocking(move || {
        run_ask(
            &st,
            &agent,
            req,
            Box::new(move |v| {
                let _ = app.emit("ai-run", v);
            }),
        )
    })
    .await
}

/// 问一次 AI（这台电脑上的界面和局域网里叫的都走这里）。run 不为空时边跑边把进展和要确认的事交给 emit
fn run_ask(
    st: &Arc<AppState>,
    agent: &Agent,
    req: xp_server::AskReq,
    emit: Box<dyn Fn(Value) + Send + Sync>,
) -> Result<agent::Answer, String> {
    let xp_server::AskReq {
        cwd,
        prompt,
        images,
        key,
        run,
        resume,
        ..
    } = req;
    let dir = std::path::Path::new(cwd.trim());
    let dir_run = if !cwd.trim().is_empty() && dir.is_dir() {
        dir.to_path_buf()
    } else {
        let k: String = key
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
            .take(40)
            .collect();
        std::env::temp_dir()
            .join("xpanel-ask")
            .join(if k.is_empty() { "note".into() } else { k })
    };
    let mut files = vec![];
    if !images.is_empty() {
        let d = dir_run.join(agent::ASK_FILES);
        std::fs::create_dir_all(&d).map_err(|e| format!("建图片目录失败：{e}"))?;
        for n in images.iter().take(40) {
            let Ok(n) = xp_store::safe_asset_name(n) else {
                continue;
            };
            let f = d.join(&n);
            if !f.exists() {
                match asset_bytes(st, &n) {
                    Ok(b) => std::fs::write(&f, b).map_err(|e| format!("写图片失败：{e}"))?,
                    Err(_) => continue,
                }
            }
            files.push(f);
        }
    }
    std::fs::create_dir_all(&dir_run).map_err(|e| e.to_string())?;
    let mcp = mcp_link(&st.cfg(), &agent.name);
    // 给了编号的：边跑边把进展和要确认的事发出去（事件 ai-run）
    let live = (!run.trim().is_empty()).then(|| runs::start(&run, emit));
    let out = agent::ask(
        agent,
        &dir_run.to_string_lossy(),
        &prompt,
        &files,
        agent::Extras {
            mcp: mcp.as_ref(),
            watch: live.as_deref().map(|r| r as &dyn live::Watch),
            resume: resume.as_deref(),
        },
        600,
    );
    if live.is_some() {
        runs::finish(&run);
    }
    out
}

/// 局域网里叫这台主机上的 AI（主机设置里打开「允许局域网叫本机的 AI」才会用到，见 xp-server 的 remote.rs）。
/// 只认名字，命令用这台电脑设置里的；确认请求发回发起的那一端回答，这台电脑的窗口里也能看到
struct HostAgents {
    st: Arc<AppState>,
    app: AppHandle,
}

impl xp_server::AgentHost for HostAgents {
    fn agents(&self) -> Value {
        let cfg = self.st.cfg();
        let list: Vec<Value> = cfg
            .agents
            .iter()
            .filter(|a| agent::ask_command(a).is_some())
            .map(|a| json!({ "name": a.name }))
            .collect();
        json!({ "agents": list, "device": { "id": cfg.device_id, "hostname": device::hostname() } })
    }

    fn ask(
        &self,
        req: xp_server::AskReq,
        emit: Box<dyn Fn(Value) + Send + Sync>,
    ) -> Result<Value, String> {
        let cfg = self.st.cfg();
        let a = cfg
            .agents
            .iter()
            .find(|a| a.name == req.agent && agent::ask_command(a).is_some())
            .cloned()
            .ok_or_else(|| format!("主机上没有能在后台回答的「{}」", req.agent))?;
        let app = self.app.clone();
        let out = run_ask(
            &self.st,
            &a,
            req,
            Box::new(move |v| {
                emit(v.clone());
                let _ = app.emit("ai-run", v);
            }),
        )?;
        serde_json::to_value(out).map_err(|e| e.to_string())
    }

    fn decide(&self, run: &str, id: &str, decision: &str) -> Result<(), String> {
        runs::decide(run, id, decision)
    }

    fn stop(&self, run: &str) {
        runs::stop(run)
    }
}

#[tauri::command]
async fn create_desktop_shortcut() -> Result<String, String> {
    blocking(shortcut::create).await
}

/// 从旧版 Workbench 的配置目录搬设置和离线队列（只在新配置不存在时）
fn migrate_old_config(cfg_dir: &std::path::Path) {
    let Some(old) = cfg_dir.parent().map(|p| p.join(OLD_IDENTIFIER)) else {
        return;
    };
    if cfg_dir.join("config.json").exists() || !old.join("config.json").exists() {
        return;
    }
    for f in ["config.json", "pending.json", "cache.json", "rejected.json"] {
        let _ = fs::copy(old.join(f), cfg_dir.join(f));
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let cfg_dir = app.path().app_config_dir()?;
            let _ = fs::create_dir_all(&cfg_dir);
            let cfg_path = cfg_dir.join("config.json");
            // 第一次运行（包括从旧版升级）时在桌面放一个快捷方式
            if cfg!(windows) && !cfg_path.exists() {
                std::thread::spawn(|| {
                    let _ = shortcut::create();
                });
            }
            migrate_old_config(&cfg_dir);
            let mut cfg: Config = fs::read_to_string(&cfg_path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default();
            if cfg_path.exists() && cfg.move_old_port() {
                if let Ok(body) = serde_json::to_string_pretty(&cfg) {
                    let _ = fs::write(&cfg_path, body);
                }
            }
            let st = Arc::new(AppState {
                cfg: Mutex::new(cfg),
                cfg_path,
                cache_dir: cfg_dir,
                store: Mutex::new(None),
                lan: Mutex::new(None),
            });
            client::set_token(&st.cfg().server_token);
            if let Err(e) = start_lan(&st, app.handle()) {
                eprintln!("{e}");
            }
            // 每分钟上报一次心跳（在线状态、当前 IP）
            let hb = st.clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_secs(3));
                if let Err(e) = device::send_heartbeat(&hb) {
                    eprintln!("心跳失败：{e}");
                }
                std::thread::sleep(Duration::from_secs(57));
            });
            app.manage(st);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            get_state,
            get_rev,
            apply_op,
            open_target,
            open_data_dir,
            run_agent,
            create_desktop_shortcut,
            put_asset,
            get_asset,
            get_ui_override,
            set_this_device,
            api_call,
            ask_ai,
            ai_decide,
            ai_stop,
            save_download,
            set_sync_dir,
            workspace::workspace_defaults,
            workspace::workspace_check,
            workspace::workspace_prepare,
            workspace::workspace_sync,
            workspace::workspace_handoff
        ])
        .run(tauri::generate_context!())
        .expect("xpanel 启动失败");
}

/// `xpanel --serve <数据文件夹> [端口]`：只开网页服务，不开窗口
pub fn serve_cli(dir: String, port: u16) {
    match Store::open(&dir) {
        Ok(st) => {
            if let Err(e) = xp_server::serve_blocking(Arc::new(st), port) {
                eprintln!("{e}");
            }
        }
        Err(e) => eprintln!("{e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_keeps_cold_dir_and_migrates() {
        // 旧界面发来的设置没有 coldBackupDir 字段：反序列化为 None，保存时保留原值
        let c: Config =
            serde_json::from_value(json!({"mode":"host","dataDir":"D:\\xpanel"})).unwrap();
        assert!(c.cold_backup_dir.is_none());
        assert_eq!(c.port, xp_server::DEFAULT_PORT);
        assert!(!c.port_moved);
        let base = std::env::temp_dir().join(format!("xp-app-cfg-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let old = base.join(OLD_IDENTIFIER);
        let new = base.join("io.github.leon6002.xpanel");
        fs::create_dir_all(&old).unwrap();
        fs::create_dir_all(&new).unwrap();
        fs::write(
            old.join("config.json"),
            r#"{"mode":"client","serverUrl":"http://h:8765"}"#,
        )
        .unwrap();
        fs::write(old.join("pending.json"), "[]").unwrap();
        migrate_old_config(&new);
        assert!(new.join("config.json").exists() && new.join("pending.json").exists());
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn old_default_port_moves_once() {
        let mut c: Config = serde_json::from_value(
            json!({"mode":"client","port":8765,"serverUrl":"http://pc:8765/"}),
        )
        .unwrap();
        assert!(c.move_old_port());
        assert_eq!(c.port, 28765);
        assert_eq!(c.server_url, "http://pc:28765");
        assert!(!c.move_old_port());
        // 自己选的别的端口不动
        let mut c: Config =
            serde_json::from_value(json!({"port":9000,"serverUrl":"http://pc:9000"})).unwrap();
        c.move_old_port();
        assert_eq!((c.port, c.server_url.as_str()), (9000, "http://pc:9000"));
        // 新装的不用挪；挪过以后再改回 8765 也不动
        let mut c = Config {
            port: 8765,
            ..Default::default()
        };
        assert!(!c.move_old_port());
        assert_eq!(c.port, 8765);
    }

    #[test]
    fn host_mode_api_call_and_heartbeat() {
        let base = std::env::temp_dir().join(format!("xp-app-api-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        let cfg = Config {
            mode: "host".into(),
            data_dir: base.join("data").to_string_lossy().to_string(),
            ..Default::default()
        };
        let st = Arc::new(AppState {
            cfg: Mutex::new(cfg),
            cfg_path: base.join("config.json"),
            cache_dir: base.clone(),
            store: Mutex::new(None),
            lan: Mutex::new(None),
        });
        let rt = tokio::runtime::Runtime::new().unwrap();
        // 界面通过 api_call 建设备
        let r = rt
            .block_on(device::api_call(
                st.clone(),
                "POST".into(),
                "/devices".into(),
                Some(json!({"name":"台式机"})),
            ))
            .unwrap();
        assert_eq!(r["status"], 201);
        let id = r["body"]["id"].as_str().unwrap().to_string();
        let r = rt
            .block_on(device::api_call(
                st.clone(),
                "POST".into(),
                "/devices".into(),
                Some(json!({"name":"台式机"})),
            ))
            .unwrap();
        assert_eq!(r["status"], 400);
        assert!(rt
            .block_on(device::api_call(
                st.clone(),
                "GET".into(),
                "/../api/state".into(),
                None
            ))
            .is_err());
        // 没选设备时不发心跳；选了之后心跳写进设备记录
        device::send_heartbeat(&st).unwrap();
        assert!(st
            .host_store()
            .unwrap()
            .get_device(&id)
            .unwrap()
            .get("lastSeen")
            .is_none());
        st.cfg.lock().unwrap().device_id = id.clone();
        device::send_heartbeat(&st).unwrap();
        let d = st.host_store().unwrap().get_device(&id).unwrap();
        assert!(d["lastSeen"].as_f64().is_some());
        assert_eq!(d["isHost"], true);
        assert_eq!(d["hostname"], json!(device::hostname()));
        let _ = fs::remove_dir_all(base);
    }
}
