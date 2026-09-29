//! xp：xpanel 命令行。给人用，也给在终端里干活的 AI 用（加 --json 输出结构化结果）。
//!
//! 连接哪个 xpanel：环境变量 XPANEL_URL（默认 http://127.0.0.1:8765）
//! 身份：环境变量 XPANEL_KEY（用 `xp key create <名字>` 在主机上生成）

mod mcp;
mod ws;

use clap::{Args, Parser, Subcommand};
use serde_json::{json, Map, Value};
use std::io::Read;
use std::process::ExitCode;
use std::sync::Arc;

#[derive(Parser)]
#[command(name = "xp", version, about = "xpanel 工作台命令行", long_about = None)]
struct Cli {
    /// xpanel 主机地址
    #[arg(
        long,
        env = "XPANEL_URL",
        default_value = "http://127.0.0.1:8765",
        global = true
    )]
    url: String,
    /// API key（xp key create 生成）
    #[arg(long, env = "XPANEL_KEY", hide_env_values = true, global = true)]
    key: Option<String>,
    /// 没有 key 时，用这个名字标明是谁在操作
    #[arg(long = "as", env = "XPANEL_ACTOR", global = true)]
    actor: Option<String>,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// 新建条目：xp add "写周报" -p P1 --tag 周报 --due 2026-10-08
    Add {
        /// 标题（多个词会拼起来）
        #[arg(required = true)]
        title: Vec<String>,
        /// 类型：todo / issue / idea / note / link / rule
        #[arg(short = 't', long = "type", default_value = "todo")]
        kind: String,
        #[arg(short, long)]
        priority: Option<String>,
        #[arg(long = "tag")]
        tags: Vec<String>,
        /// 分类，如 工作/AutoSAR
        #[arg(short = 'c', long)]
        category: Option<String>,
        /// 截止日期 YYYY-MM-DD
        #[arg(long)]
        due: Option<String>,
        /// 正文（Markdown）；传 - 表示从标准输入读
        #[arg(short, long)]
        body: Option<String>,
        /// 指定 id（重复执行不会多出一条）
        #[arg(long)]
        id: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// 列出条目
    Ls {
        #[command(flatten)]
        filter: FilterArgs,
        #[arg(long, default_value_t = 50)]
        limit: usize,
        #[arg(long)]
        json: bool,
    },
    /// 查看一条
    Show {
        id: String,
        #[arg(long)]
        json: bool,
    },
    /// 标记完成
    Done { id: String },
    /// 取消完成
    Undo { id: String },
    /// 改字段：xp set <id> priority=P1 due=2026-10-08 title="新标题"；值写 null 表示删除该字段
    Set {
        id: String,
        #[arg(required = true)]
        fields: Vec<String>,
    },
    /// 删除
    Rm { id: String },
    /// 导出（默认 Markdown，适合交给 AI）
    Export {
        #[arg(short, long, default_value = "md")]
        format: String,
        #[command(flatten)]
        filter: FilterArgs,
        /// 写到文件，不写就打印出来
        #[arg(short, long)]
        output: Option<String>,
    },
    /// 统计：各类型数量、优先级分布、逾期、长期未动、最近 8 周趋势
    Stats {
        #[command(flatten)]
        filter: FilterArgs,
        #[arg(long)]
        json: bool,
    },
    /// 导入微信聊天记录（微信里多选消息 → 合并转发 → 导出的 ZIP）
    Import {
        /// ZIP 文件
        file: String,
        /// 聊天名（导出里没有群名）；不填就按发送人或已有聊天猜一个
        #[arg(long)]
        chat: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// 收件箱里的聊天列表
    Chats {
        #[arg(long)]
        json: bool,
    },
    /// 把一个聊天的消息导出成 Markdown（交给 AI 读）：xp chat 项目群 --unread --mark-read
    Chat {
        /// 聊天名或 id
        chat: String,
        /// 只要还没处理的（「已处理到」之后的）
        #[arg(long)]
        unread: bool,
        /// 起始时间 YYYY-MM-DD 或 YYYY-MM-DD HH:MM
        #[arg(long)]
        from: Option<String>,
        #[arg(long)]
        to: Option<String>,
        /// 导出后把聊天标成已处理到最后一条
        #[arg(long)]
        mark_read: bool,
        #[arg(short, long)]
        output: Option<String>,
    },
    /// MCP 服务（给 Claude Code、Codex 等 AI 用）：claude mcp add xpanel -- xp mcp
    Mcp,
    /// 把笔记展开成项目目录（给 AI 当工作目录）、同步、生成「继续」的提示词
    Workspace {
        #[command(subcommand)]
        cmd: WsCmd,
    },
    /// 回写进展到条目的「AI 进展」：xp report "还原了 3 个文件" --status working
    Report {
        text: String,
        /// working / done / blocked
        #[arg(long, default_value = "working")]
        status: String,
        /// 条目 id；不填就用当前项目对应的条目
        #[arg(long)]
        item: Option<String>,
    },
    /// 管理 API key（在存数据的主机上运行，直接读写数据文件夹）
    Key {
        #[command(subcommand)]
        cmd: KeyCmd,
    },
    /// 只开网页服务，不开窗口（可放在 Linux 主机或 Docker 里）
    Serve {
        /// 数据文件夹
        #[arg(long, env = "XPANEL_DATA")]
        data: String,
        #[arg(long, default_value_t = xp_server::DEFAULT_PORT)]
        port: u16,
        /// 冷备份文件夹（可选）
        #[arg(long)]
        cold_backup: Option<String>,
    },
}

#[derive(Subcommand)]
enum WsCmd {
    /// 新建：xp workspace create <条目id> --name leap-motor-code --template rebuild
    Create {
        id: String,
        /// 项目名（不填按标题起）
        #[arg(long)]
        name: Option<String>,
        /// 放在哪个目录下（默认 D:\codes 或 ~/codes）
        #[arg(long)]
        root: Option<String>,
        /// 模板 id：general / rebuild / chat / debug
        #[arg(long, default_value = "general")]
        template: String,
        /// 不要 git init
        #[arg(long)]
        no_git: bool,
    },
    /// 把笔记的最新内容同步进当前项目
    Sync {
        #[arg(long)]
        path: Option<String>,
    },
    /// 先同步，再输出交给 AI 的提示词（第一次是模板的开场白，之后只说新增了什么）
    Prompt {
        #[arg(long)]
        path: Option<String>,
    },
}

#[derive(Subcommand)]
enum KeyCmd {
    /// 新建一把 key（明文只显示这一次）
    Create {
        name: String,
        #[arg(long, env = "XPANEL_DATA")]
        data: String,
    },
    /// 列出所有 key
    List {
        #[arg(long, env = "XPANEL_DATA")]
        data: String,
    },
    /// 删除 key
    Rm {
        name: String,
        #[arg(long, env = "XPANEL_DATA")]
        data: String,
    },
}

#[derive(Args, Default)]
struct FilterArgs {
    /// 类型，逗号分隔
    #[arg(short = 't', long = "type")]
    kind: Option<String>,
    /// open / done / all
    #[arg(short, long)]
    status: Option<String>,
    #[arg(long)]
    tag: Option<String>,
    /// 分类（包括子分类）；none = 未分类
    #[arg(short = 'c', long)]
    category: Option<String>,
    /// 优先级，逗号分隔（P0,P1 / none）
    #[arg(short, long)]
    priority: Option<String>,
    /// 关键词
    #[arg(short, long)]
    query: Option<String>,
}

impl FilterArgs {
    fn pairs(&self) -> Vec<(&'static str, String)> {
        let mut v = vec![];
        let mut push = |k: &'static str, x: &Option<String>| {
            if let Some(s) = x.as_ref().filter(|s| !s.is_empty()) {
                v.push((k, s.clone()));
            }
        };
        push("type", &self.kind);
        push("status", &self.status);
        push("tag", &self.tag);
        push("category", &self.category);
        push("priority", &self.priority);
        push("q", &self.query);
        v
    }
}

// ---------------------------------------------------------------- HTTP

struct Client {
    base: String,
    key: Option<String>,
    actor: Option<String>,
}

impl Client {
    fn req(&self, method: &str, path: &str, query: &[(&str, String)]) -> ureq::Request {
        let mut r = ureq::request(
            method,
            &format!("{}/api/v1{}", self.base.trim_end_matches('/'), path),
        )
        .timeout(std::time::Duration::from_secs(30));
        for (k, v) in query {
            r = r.query(k, v);
        }
        if let Some(k) = &self.key {
            r = r.set("Authorization", &format!("Bearer {k}"));
        } else if let Some(a) = &self.actor {
            r = r.set("X-Actor", a);
        }
        r
    }

    fn done(&self, r: Result<ureq::Response, ureq::Error>) -> Result<ureq::Response, String> {
        match r {
            Ok(r) => Ok(r),
            Err(ureq::Error::Status(code, r)) => {
                let msg = r
                    .into_json::<Value>()
                    .ok()
                    .and_then(|v| v["error"].as_str().map(String::from))
                    .unwrap_or_default();
                Err(format!("xpanel 返回 {code}：{msg}"))
            }
            Err(ureq::Error::Transport(t)) => Err(format!(
                "连不上 xpanel（{}）：{t}\n用 --url 或环境变量 XPANEL_URL 指定地址",
                self.base
            )),
        }
    }

    fn get(&self, path: &str, query: &[(&str, String)]) -> Result<Value, String> {
        self.done(self.req("GET", path, query).call())?
            .into_json()
            .map_err(|e| e.to_string())
    }

    fn text(&self, path: &str, query: &[(&str, String)]) -> Result<String, String> {
        self.done(self.req("GET", path, query).call())?
            .into_string()
            .map_err(|e| e.to_string())
    }

    fn send(&self, method: &str, path: &str, body: Value) -> Result<Value, String> {
        let r = self.done(self.req(method, path, &[]).send_json(body))?;
        if r.status() == 204 {
            return Ok(Value::Null);
        }
        r.into_json().map_err(|e| e.to_string())
    }
}

// ---------------------------------------------------------------- 输出

fn line(v: &Value) -> String {
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("");
    let check = if xp_core::is_checkable(s("type")) {
        if v["done"].as_bool().unwrap_or(false) {
            "[x] "
        } else {
            "[ ] "
        }
    } else {
        "    "
    };
    let mut out = check.to_string();
    if !s("priority").is_empty() {
        out += &format!("{} ", s("priority"));
    }
    if !s("category").is_empty() {
        out += &format!("[{}] ", s("category"));
    }
    out += s("title");
    let tags = xp_core::tags_of(v);
    if !tags.is_empty() {
        out += &format!(
            "  {}",
            tags.iter()
                .map(|t| format!("#{t}"))
                .collect::<Vec<_>>()
                .join(" ")
        );
    }
    if !s("due").is_empty() {
        out += &format!("  截止 {}", s("due"));
    }
    out += &format!("  ({} · {})", xp_core::type_label(s("type")), s("id"));
    out
}

fn pretty(v: &Value) {
    println!("{}", serde_json::to_string_pretty(v).unwrap_or_default());
}

fn print_stats(s: &Value) {
    println!(
        "共 {} 条：未完成 {}，已完成 {}",
        s["total"], s["open"], s["done"]
    );
    let p = &s["openByPriority"];
    println!(
        "未完成的待办 / 问题 / 灵感按优先级：P0 {} · P1 {} · P2 {} · P3 {} · 未设 {}",
        p["P0"], p["P1"], p["P2"], p["P3"], p["none"]
    );
    if let Some(o) = s["overdue"].as_array().filter(|a| !a.is_empty()) {
        println!("逾期 {} 条：", o.len());
        for x in o.iter().take(10) {
            println!(
                "  {}  截止 {}  ({})",
                x["title"].as_str().unwrap_or(""),
                x["due"].as_str().unwrap_or(""),
                x["id"].as_str().unwrap_or("")
            );
        }
    }
    println!(
        "{} 天以上没动的：{} 条",
        s["stale"]["days"], s["stale"]["count"]
    );
    if let Some(w) = s["weekly"].as_array() {
        println!(
            "最近 {} 周（新建 / 完成）：{}",
            w.len(),
            w.iter()
                .map(|x| format!("{}/{}", x["created"], x["completed"]))
                .collect::<Vec<_>>()
                .join("  ")
        );
    }
}

fn parse_value(s: &str) -> Value {
    serde_json::from_str::<Value>(s)
        .ok()
        .filter(|v| !v.is_string() || s.starts_with('"'))
        .unwrap_or_else(|| json!(s))
}

fn read_body(b: Option<String>) -> Result<Option<String>, String> {
    match b.as_deref() {
        Some("-") => {
            let mut s = String::new();
            std::io::stdin()
                .read_to_string(&mut s)
                .map_err(|e| e.to_string())?;
            Ok(Some(s))
        }
        _ => Ok(b),
    }
}

// ---------------------------------------------------------------- 主流程

fn run(cli: Cli) -> Result<(), String> {
    let c = Client {
        base: cli.url.clone(),
        key: cli.key.clone(),
        actor: cli.actor.clone(),
    };
    match cli.cmd {
        Cmd::Add {
            title,
            category,
            kind,
            priority,
            tags,
            due,
            body,
            id,
            json,
        } => {
            let mut o = Map::new();
            o.insert("title".into(), json!(title.join(" ")));
            o.insert("type".into(), json!(kind));
            if let Some(p) = priority {
                o.insert("priority".into(), json!(p));
            }
            if !tags.is_empty() {
                o.insert("tags".into(), json!(tags));
            }
            if let Some(c) = category {
                o.insert("category".into(), json!(c));
            }
            if let Some(d) = due {
                o.insert("due".into(), json!(d));
            }
            if let Some(b) = read_body(body)? {
                o.insert("body".into(), json!(b));
            }
            if let Some(i) = id {
                o.insert("id".into(), json!(i));
            }
            let v = c.send("POST", "/items", Value::Object(o))?;
            if json {
                pretty(&v)
            } else {
                println!("已添加：{}", line(&v))
            }
        }
        Cmd::Ls {
            filter,
            limit,
            json,
        } => {
            let mut q = filter.pairs();
            q.push(("limit", limit.to_string()));
            let v = c.get("/items", &q)?;
            if json {
                pretty(&v);
            } else {
                for it in v["items"].as_array().into_iter().flatten() {
                    println!("{}", line(it));
                }
                if v["total"].as_u64() > v["count"].as_u64() {
                    println!(
                        "……共 {} 条，只显示了 {} 条（用 --limit 调整）",
                        v["total"], v["count"]
                    );
                }
            }
        }
        Cmd::Show { id, json } => {
            let v = c.get(&format!("/items/{id}"), &[])?;
            if json {
                pretty(&v);
            } else {
                println!("{}", line(&v));
                let body = v["body"].as_str().unwrap_or("").trim();
                if !body.is_empty() {
                    println!("\n{body}");
                }
            }
        }
        Cmd::Done { id } => println!(
            "{}",
            line(&c.send("PATCH", &format!("/items/{id}"), json!({"done": true}))?)
        ),
        Cmd::Undo { id } => println!(
            "{}",
            line(&c.send("PATCH", &format!("/items/{id}"), json!({"done": false}))?)
        ),
        Cmd::Set { id, fields } => {
            let mut o = Map::new();
            for f in fields {
                let (k, v) = f
                    .split_once('=')
                    .ok_or_else(|| format!("{f} 要写成 字段=值"))?;
                let v = if k == "title" || k == "body" {
                    json!(v)
                } else {
                    parse_value(v)
                };
                o.insert(k.trim().to_string(), v);
            }
            println!(
                "{}",
                line(&c.send("PATCH", &format!("/items/{id}"), Value::Object(o))?)
            );
        }
        Cmd::Rm { id } => {
            c.send("DELETE", &format!("/items/{id}"), json!({}))?;
            println!("已删除 {id}");
        }
        Cmd::Export {
            format,
            filter,
            output,
        } => {
            let mut q = filter.pairs();
            q.push(("format", format));
            let s = c.text("/export", &q)?;
            match output {
                Some(p) => {
                    std::fs::write(&p, s).map_err(|e| format!("写入 {p} 失败：{e}"))?;
                    println!("已导出到 {p}");
                }
                None => print!("{s}"),
            }
        }
        Cmd::Stats { filter, json } => {
            let v = c.get("/stats", &filter.pairs())?;
            if json {
                pretty(&v)
            } else {
                print_stats(&v)
            }
        }
        Cmd::Import { file, chat, json } => {
            let data = std::fs::read(&file).map_err(|e| format!("读取 {file} 失败：{e}"))?;
            let name = std::path::Path::new(&file)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            let mut q = vec![("name", name)];
            if let Some(ch) = chat {
                q.push(("chat", ch));
            }
            let r = c
                .req("POST", "/inbox/wechat/import", &q)
                .timeout(std::time::Duration::from_secs(600))
                .set("Content-Type", "application/zip")
                .send_bytes(&data);
            let v: Value = c.done(r)?.into_json().map_err(|e| e.to_string())?;
            if json {
                pretty(&v)
            } else {
                println!(
                    "已导入到「{}」：{} 条，新增 {} 条，重复 {} 条（{} 至 {}）",
                    v["chat"]["name"].as_str().unwrap_or(""),
                    v["total"],
                    v["added"],
                    v["duplicates"],
                    v["bundle"]["start"].as_str().unwrap_or(""),
                    v["bundle"]["end"].as_str().unwrap_or("")
                );
            }
        }
        Cmd::Chats { json } => {
            let v = c.get("/inbox/chats", &[])?;
            if json {
                pretty(&v)
            } else {
                for ch in v["chats"].as_array().cloned().unwrap_or_default() {
                    println!(
                        "{}  {}  {} 条，未处理 {}，最后 {}",
                        ch["id"].as_str().unwrap_or(""),
                        ch["name"].as_str().unwrap_or(""),
                        ch["count"],
                        ch["unread"],
                        ch["last"]["time"].as_str().unwrap_or("-")
                    );
                }
            }
        }
        Cmd::Chat {
            chat,
            unread,
            from,
            to,
            mark_read,
            output,
        } => {
            let list = c.get("/inbox/chats", &[])?;
            let found = list["chats"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .find(|ch| ch["id"] == chat.as_str() || ch["name"] == chat.as_str())
                .ok_or_else(|| format!("找不到聊天「{chat}」，用 xp chats 看有哪些"))?;
            let id = found["id"].as_str().unwrap_or("").to_string();
            let mut q = vec![("chat", id.clone())];
            if unread {
                q.push(("unread", "1".into()));
            }
            if let Some(f) = from {
                q.push(("from", f));
            }
            if let Some(t) = to {
                q.push(("to", format!("{t}\u{10ffff}")));
            }
            let md = c.text("/inbox/markdown", &q)?;
            match output {
                Some(o) => std::fs::write(&o, &md).map_err(|e| format!("写入 {o} 失败：{e}"))?,
                None => print!("{md}"),
            }
            if mark_read {
                let mut mq = q.clone();
                mq.push(("limit", "1".into()));
                let last = c.get("/inbox/messages", &mq)?;
                if let Some(t) = last["messages"][0]["time"].as_str() {
                    c.send(
                        "PATCH",
                        &format!("/inbox/chats/{id}"),
                        serde_json::json!({"readUpTo": t}),
                    )?;
                    eprintln!("已标记处理到 {t}");
                }
            }
        }
        Cmd::Mcp => {
            let c = Client {
                actor: c.actor.clone().or_else(|| Some("mcp".into())),
                ..c
            };
            mcp::serve(&c)?
        }
        Cmd::Workspace { cmd } => match cmd {
            WsCmd::Create {
                id,
                name,
                root,
                template,
                no_git,
            } => {
                let r = ws::create(
                    &c,
                    &id,
                    name.as_deref(),
                    root.as_deref(),
                    &template,
                    !no_git,
                )?;
                println!("{}\n{}", r.path.display(), r.summary);
                if !r.missing.is_empty() {
                    eprintln!("读不到的附件：{}", r.missing.join("、"));
                }
            }
            WsCmd::Sync { path } => {
                let (dir, ch, images) = ws::sync(&c, path.as_deref())?;
                println!("{}：{}", dir.display(), ch.summary(images));
            }
            WsCmd::Prompt { path } => {
                let (dir, _, _) = ws::sync(&c, path.as_deref())?;
                let (p, _) = xp_workspace::handoff(&dir)?;
                println!("{p}");
            }
        },
        Cmd::Report { text, status, item } => {
            let id = item
                .or_else(ws::item_of_cwd)
                .ok_or("不在 xpanel 生成的项目里，请用 --item 指定条目")?;
            c.send(
                "POST",
                &format!("/items/{}/progress", mcp::enc(&id)),
                json!({"text": text, "status": status}),
            )?;
            println!("已回写");
        }
        Cmd::Key { cmd } => {
            let open = |d: &str| xp_store::Store::open(d).map_err(|e| e.to_string());
            match cmd {
                KeyCmd::Create { name, data } => {
                    let k = open(&data)?.create_key(&name).map_err(|e| e.to_string())?;
                    println!("已为 {name} 创建 key（只显示这一次，请保存好）：\n{k}\n\n使用：设置环境变量 XPANEL_KEY，或请求头 Authorization: Bearer <key>");
                }
                KeyCmd::List { data } => {
                    for k in open(&data)?.list_keys().map_err(|e| e.to_string())? {
                        let used = k["lastUsed"]
                            .as_f64()
                            .and_then(xp_core::local_date_of)
                            .map(|d| d.to_string())
                            .unwrap_or_else(|| "从未使用".into());
                        println!("{}  最后使用：{used}", k["name"].as_str().unwrap_or(""));
                    }
                }
                KeyCmd::Rm { name, data } => {
                    open(&data)?.delete_key(&name).map_err(|e| e.to_string())?;
                    println!("已删除 {name}");
                }
            }
        }
        Cmd::Serve {
            data,
            port,
            cold_backup,
        } => {
            let st = xp_store::Store::open(&data).map_err(|e| e.to_string())?;
            st.set_cold_backup_dir(cold_backup.map(Into::into));
            xp_server::serve_blocking(Arc::new(st), port)?;
        }
    }
    Ok(())
}

fn main() -> ExitCode {
    match run(Cli::parse()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("{e}");
            ExitCode::FAILURE
        }
    }
}
