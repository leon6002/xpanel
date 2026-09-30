//! `xp mcp`：MCP 服务（标准输入输出，JSON-RPC 2.0，一行一条消息）。
//!
//! 让 Claude Code、Codex 等支持 MCP 的 AI 在任何项目里直接读写 xpanel：
//!
//! ```text
//! claude mcp add xpanel -e XPANEL_URL=http://主机:8765 -e XPANEL_KEY=xp_… -- xp mcp
//! ```
//!
//! 每个工具都是对 /api/v1 的一次调用，所以权限、校验、操作记录和网页 / 命令行完全一样。
//! 标准输出只写协议消息，日志写到标准错误。

use crate::Client;
use serde_json::{json, Map, Value};
use std::io::{BufRead, Write};

const PROTOCOL_VERSIONS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS: &str = "xpanel 是用户的个人工作台：待办（todo）、问题（issue）、灵感（idea）、笔记（note）、入口（link）、规范（rule），\
以及收件箱（inbox：随手发进来、还没归类的）和导入的微信聊天记录。\n\
约定：priority 是 P0（最急）到 P3；due 是 YYYY-MM-DD；category 是用 / 分层的分类路径（如 工作/AutoSAR）；tags 不带 #。\n\
建议：写入前先用 xpanel_list_items 查一下有没有重复；批量改优先级先 dryRun 给用户看，确认后再提交；\
处理微信消息时用 xpanel_chat_messages 取「未处理」的，处理完用 xpanel_chat_mark_processed 标记，下次就不会重复。\n\
如果当前目录是 xpanel 生成的项目（有 .xpanel/TASK.md）：开始和每次继续前先调 xpanel_workspace_sync 拉取最新笔记，\
有阶段性进展、做完或卡住时调 xpanel_report 回写（itemId 可以不填，自动用当前项目对应的条目）。";

fn filter_props() -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("type".into(), json!({"type":"string","description":"类型，逗号分隔：todo,issue,idea,note,link,rule,inbox"}));
    m.insert("status".into(), json!({"type":"string","enum":["open","done","all"],"description":"open 未完成 / done 已完成 / all（默认）"}));
    m.insert(
        "tag".into(),
        json!({"type":"string","description":"标签（不带 #）"}),
    );
    m.insert(
        "category".into(),
        json!({"type":"string","description":"分类路径（包括子分类）；none 表示未分类"}),
    );
    m.insert(
        "priority".into(),
        json!({"type":"string","description":"优先级，逗号分隔：P0,P1,P2,P3,none"}),
    );
    m.insert(
        "q".into(),
        json!({"type":"string","description":"关键词，搜标题和正文；空格隔开表示都要包含"}),
    );
    m.insert(
        "device".into(),
        json!({"type":"string","description":"设备名"}),
    );
    m
}

fn with(mut base: Map<String, Value>, extra: Value) -> Value {
    if let Value::Object(e) = extra {
        base.extend(e);
    }
    Value::Object(base)
}

fn item_fields() -> Value {
    json!({
        "title": {"type":"string","description":"标题（必填）"},
        "type": {"type":"string","enum":["todo","issue","idea","note","link","rule","inbox"],"description":"默认 todo"},
        "body": {"type":"string","description":"正文，Markdown"},
        "priority": {"type":"string","enum":["P0","P1","P2","P3"]},
        "due": {"type":"string","description":"截止日期 YYYY-MM-DD"},
        "tags": {"type":"array","items":{"type":"string"}},
        "category": {"type":"string","description":"分类路径，如 工作/AutoSAR"},
        "device": {"type":"string","description":"相关设备名"},
        "parentId": {"type":"string","description":"可选。父笔记的 id：写成它的子笔记（笔记和规范可以分层）"},
        "links": {"type":"array","items":{"type":"object","properties":{"id":{"type":"string"},"label":{"type":"string"}},"required":["id"]},
                  "description":"可选。关联的其他条目，label 写关系（如 岗位、简历、题库、流程、工具、产出）。读一条时顺着 links 用 xpanel_get_item 取关联内容"},
        "id": {"type":"string","description":"可选。指定 id 就是幂等写入：重复提交只会更新，不会多出一条"}
    })
}

pub fn tools() -> Value {
    json!([
        {"name":"xpanel_list_items","description":"查询条目（待办、问题、灵感、笔记、入口、规范、收件箱）。按置顶、优先级、手动排序、最近更新排好序。",
         "inputSchema": {"type":"object","properties": with(filter_props(), json!({
            "limit":{"type":"integer","default":50,"maximum":5000},"offset":{"type":"integer","default":0}}))},
         "annotations":{"readOnlyHint":true}},
        {"name":"xpanel_get_item","description":"读取一条完整的条目（含正文）。links 里是关联的条目 id 和关系标签（岗位、简历、题库等），需要时再逐个读取。",
         "inputSchema":{"type":"object","properties":{"id":{"type":"string"}},"required":["id"]},"annotations":{"readOnlyHint":true}},
        {"name":"xpanel_create_items","description":"新建一条或多条条目。每条至少要有 title；指定 id 可以幂等写入。",
         "inputSchema":{"type":"object","properties":{"items":{"type":"array","minItems":1,"items":{"type":"object","properties":item_fields(),"required":["title"]}}},"required":["items"]}},
        {"name":"xpanel_update_item","description":"按字段修改一条条目：只改传了的字段，值为 null 表示删除这个字段。可改 title/body/type/priority/due/tags/category/device/pinned/done/parentId/links 等（links 要整体传新数组）。",
         "inputSchema":{"type":"object","properties":{"id":{"type":"string"},"patch":{"type":"object","description":"要改的字段，如 {\"priority\":\"P1\",\"due\":\"2026-10-08\"}"}},"required":["id","patch"]},
         "annotations":{"idempotentHint":true}},
        {"name":"xpanel_complete_item","description":"把待办 / 问题 / 灵感标成完成（done=false 则取消完成）。",
         "inputSchema":{"type":"object","properties":{"id":{"type":"string"},"done":{"type":"boolean","default":true}},"required":["id"]},
         "annotations":{"idempotentHint":true}},
        {"name":"xpanel_delete_item","description":"删除一条条目（软删除，可以在操作记录里查到）。删除前先和用户确认。",
         "inputSchema":{"type":"object","properties":{"id":{"type":"string"}},"required":["id"]},"annotations":{"destructiveHint":true}},
        {"name":"xpanel_reprioritize","description":"批量调整优先级和排序。先用 dryRun=true 得到前后对比给用户看，确认后再用 dryRun=false 提交。",
         "inputSchema":{"type":"object","properties":{
            "changes":{"type":"array","items":{"type":"object","properties":{
                "id":{"type":"string"},"priority":{"type":["string","null"],"enum":["P0","P1","P2","P3",null]},
                "rank":{"type":"number","description":"同优先级内的顺序，小的在前"},"reason":{"type":"string","description":"为什么这样调（会记进操作记录）"}},"required":["id"]}},
            "dryRun":{"type":"boolean","default":true}},"required":["changes"]}},
        {"name":"xpanel_export","description":"导出条目：md（适合阅读和分析）、csv、json。可以带筛选条件。",
         "inputSchema":{"type":"object","properties": with(filter_props(), json!({"format":{"type":"string","enum":["md","csv","json"],"default":"md"}}))},
         "annotations":{"readOnlyHint":true}},
        {"name":"xpanel_stats","description":"统计：各类型数量、优先级分布、逾期、长期没动的、分类分布、最近 8 周新建和完成的趋势。",
         "inputSchema":{"type":"object","properties": filter_props()},"annotations":{"readOnlyHint":true}},
        {"name":"xpanel_taxonomy","description":"列出所有分类（带数量）、标签（带数量）和设备，写入前用来选合适的分类、标签、设备名。",
         "inputSchema":{"type":"object","properties":{}},"annotations":{"readOnlyHint":true}},
        {"name":"xpanel_inbox_send","description":"往收件箱发一条（像发消息一样，之后用户自己归类）。第一行是标题，后面是正文。适合把你整理出的待跟进事项、想法交给用户。",
         "inputSchema":{"type":"object","properties":{"text":{"type":"string"},"tags":{"type":"array","items":{"type":"string"}}},"required":["text"]}},
        {"name":"xpanel_list_chats","description":"收件箱里导入的微信聊天：名字、消息数、未处理数、已处理到的时间、最后一条消息。",
         "inputSchema":{"type":"object","properties":{}},"annotations":{"readOnlyHint":true}},
        {"name":"xpanel_chat_messages","description":"取一个聊天的消息。默认 Markdown（按天分节，适合阅读分析）；format=json 时带每条消息的 id（转成条目时要用）。",
         "inputSchema":{"type":"object","properties":{
            "chat":{"type":"string","description":"聊天名或 id"},
            "unread":{"type":"boolean","default":false,"description":"只要「已处理到」之后的"},
            "from":{"type":"string","description":"起始时间 YYYY-MM-DD 或 YYYY-MM-DD HH:MM"},"to":{"type":"string","description":"结束时间（含当天）"},
            "q":{"type":"string","description":"关键词"},
            "format":{"type":"string","enum":["md","json"],"default":"md"},
            "limit":{"type":"integer","default":500,"description":"最多多少条（从最新往前数）"}},"required":["chat"]},
         "annotations":{"readOnlyHint":true}},
        {"name":"xpanel_chat_mark_processed","description":"把聊天标成「已处理到」某个时间（默认最后一条），下次 unread 只返回之后的消息。",
         "inputSchema":{"type":"object","properties":{"chat":{"type":"string","description":"聊天名或 id"},"upTo":{"type":"string","description":"时间 YYYY-MM-DD HH:MM；不填就是最后一条"}},"required":["chat"]},
         "annotations":{"idempotentHint":true}},
        {"name":"xpanel_messages_to_item","description":"把选中的聊天消息整理成一条笔记或待办（正文是按天分节的 Markdown，图片保留）。消息 id 从 xpanel_chat_messages(format=json) 拿。",
         "inputSchema":{"type":"object","properties":{
            "ids":{"type":"array","items":{"type":"string"},"minItems":1},
            "type":{"type":"string","enum":["note","todo","issue","idea"],"default":"note"},
            "title":{"type":"string"},"category":{"type":"string"},"tags":{"type":"array","items":{"type":"string"}},
            "priority":{"type":"string","enum":["P0","P1","P2","P3"]},"due":{"type":"string"},
            "markRead":{"type":"boolean","default":true,"description":"同时把聊天标成已处理到这些消息"}},"required":["ids"]}},
        {"name":"xpanel_report","description":"回写进展到条目的「AI 进展」：做了什么、结论、还缺什么。阶段性进展、做完、卡住需要人处理时都调用。在 xpanel 生成的项目里 itemId 可以不填。",
         "inputSchema":{"type":"object","properties":{
            "itemId":{"type":"string","description":"条目 id；不填就用当前项目（.xpanel/manifest.json）对应的条目"},
            "text":{"type":"string","description":"Markdown，简洁写清楚"},
            "status":{"type":"string","enum":["working","done","blocked"],"default":"working","description":"working 进行中 / done 完成 / blocked 卡住需要人处理"},
            "files":{"type":"array","items":{"type":"string"},"description":"相关产出文件（相对项目根目录的路径）"}},"required":["text"]}},
        {"name":"xpanel_workspace_sync","description":"把笔记的最新内容同步到当前项目的 .xpanel/（新截图按编号往后加），返回这次新增了什么。开始工作和每次继续前调用。",
         "inputSchema":{"type":"object","properties":{"path":{"type":"string","description":"项目目录；不填就从当前目录往上找"}}}},
        {"name":"xpanel_workspace_create","description":"把一条笔记展开成一个项目目录（.xpanel/ 里放任务说明、笔记原文、编号截图），之后可以在这个目录里干活。项目名不填就按标题起一个。",
         "inputSchema":{"type":"object","properties":{
            "itemId":{"type":"string"},
            "name":{"type":"string","description":"项目名：英文字母、数字、- _ ."},
            "root":{"type":"string","description":"放在哪个目录下；默认 D:\\codes（没有就用 ~/codes）"},
            "template":{"type":"string","description":"任务模板 id：general 通用 / rebuild 从截图复刻项目 / chat 整理聊天记录 / debug 排查问题（或用户自建的）","default":"general"},
            "git":{"type":"boolean","default":true,"description":"新建时 git init"}},"required":["itemId"]}},
        {"name":"xpanel_add_qa","description":"往笔记上挂一条问答，显示在对应原文旁边（比如读笔记时遇到需要解释的概念）。quote 必须原样摘抄笔记正文里的一段；不填表示针对整篇。",
         "inputSchema":{"type":"object","properties":{
            "itemId":{"type":"string","description":"条目 id；不填就用当前项目对应的条目"},
            "quote":{"type":"string","description":"原文（原样摘抄，越短越好，能唯一定位即可）"},
            "question":{"type":"string"},"answer":{"type":"string","description":"Markdown"}},"required":["question","answer"]}},
        {"name":"xpanel_audit","description":"操作记录：谁在什么时候改了什么（可以只看某一条）。",
         "inputSchema":{"type":"object","properties":{"itemId":{"type":"string"},"limit":{"type":"integer","default":50}}},
         "annotations":{"readOnlyHint":true}}
    ])
}

// ---------------------------------------------------------------- 工具实现

fn s<'a>(a: &'a Value, k: &str) -> Option<&'a str> {
    a.get(k)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
}

/// 筛选参数转成查询串
fn filters(a: &Value) -> Vec<(&'static str, String)> {
    let mut q = vec![];
    for k in [
        "type", "status", "tag", "category", "priority", "q", "device",
    ] {
        if let Some(v) = s(a, k) {
            q.push((k, v.to_string()));
        }
    }
    q
}

pub(crate) fn enc(s: &str) -> String {
    let mut o = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            o.push(b as char)
        } else {
            o.push_str(&format!("%{b:02X}"))
        }
    }
    o
}

/// 聊天名或 id → 聊天
fn find_chat(c: &Client, key: &str) -> Result<Value, String> {
    let list = c.get("/inbox/chats", &[])?;
    let chats = list["chats"].as_array().cloned().unwrap_or_default();
    chats
        .iter()
        .find(|ch| ch["id"] == key)
        .or_else(|| chats.iter().find(|ch| ch["name"] == key))
        .cloned()
        .ok_or_else(|| {
            let names: Vec<&str> = chats.iter().filter_map(|c| c["name"].as_str()).collect();
            format!(
                "找不到聊天「{key}」。现有的聊天：{}",
                if names.is_empty() {
                    "（还没有导入过）".into()
                } else {
                    names.join("、")
                }
            )
        })
}

enum Out {
    Json(Value),
    Text(String),
}

fn call(c: &Client, name: &str, a: &Value) -> Result<Out, String> {
    let need = |k: &str| {
        s(a, k)
            .map(String::from)
            .ok_or_else(|| format!("缺少参数 {k}"))
    };
    Ok(match name {
        "xpanel_list_items" => {
            let mut q = filters(a);
            q.push(("limit", a["limit"].as_u64().unwrap_or(50).to_string()));
            if let Some(o) = a["offset"].as_u64() {
                q.push(("offset", o.to_string()));
            }
            Out::Json(c.get("/items", &q)?)
        }
        "xpanel_get_item" => Out::Json(c.get(&format!("/items/{}", enc(&need("id")?)), &[])?),
        "xpanel_create_items" => {
            let items = a.get("items").cloned().filter(|v| v.as_array().is_some_and(|x| !x.is_empty()));
            Out::Json(c.send("POST", "/items", items.ok_or("items 至少要有一条")?)?)
        }
        "xpanel_update_item" => {
            let patch = a.get("patch").filter(|p| p.is_object()).cloned().ok_or("patch 应该是对象")?;
            Out::Json(c.send("PATCH", &format!("/items/{}", enc(&need("id")?)), patch)?)
        }
        "xpanel_complete_item" => {
            let done = a["done"].as_bool().unwrap_or(true);
            Out::Json(c.send("PATCH", &format!("/items/{}", enc(&need("id")?)), json!({"done": done}))?)
        }
        "xpanel_delete_item" => {
            let id = need("id")?;
            c.send("DELETE", &format!("/items/{}", enc(&id)), Value::Null)?;
            Out::Text(format!("已删除 {id}"))
        }
        "xpanel_reprioritize" => Out::Json(c.send(
            "POST",
            "/items/reprioritize",
            json!({"changes": a.get("changes").cloned().unwrap_or(json!([])), "dryRun": a["dryRun"].as_bool().unwrap_or(true)}),
        )?),
        "xpanel_export" => {
            let mut q = filters(a);
            q.push(("format", s(a, "format").unwrap_or("md").to_string()));
            Out::Text(c.text("/export", &q)?)
        }
        "xpanel_stats" => Out::Json(c.get("/stats", &filters(a))?),
        "xpanel_taxonomy" => {
            let cats = c.get("/categories", &[])?;
            let tags = c.get("/tags", &[])?;
            let devs = c.get("/devices", &[])?;
            let devices: Vec<Value> = devs["devices"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .map(|d| json!({"name": d["name"], "kind": d["kind"], "description": d["description"], "projects": d["projects"]}))
                .collect();
            Out::Json(json!({"categories": cats["categories"], "tags": tags["tags"], "devices": devices}))
        }
        "xpanel_inbox_send" => {
            let text = need("text")?;
            let (first, rest) = text.split_once('\n').unwrap_or((&text, ""));
            let mut title: String = first.trim().to_string();
            let mut body = rest.trim().to_string();
            if title.chars().count() > 60 {
                body = text.clone();
                title = title.chars().take(40).collect::<String>() + "…";
            }
            let mut item = json!({"type": "inbox", "title": title, "body": body});
            if let Some(t) = a.get("tags").filter(|t| t.is_array()) {
                item["tags"] = t.clone();
            }
            Out::Json(c.send("POST", "/items", item)?)
        }
        "xpanel_list_chats" => Out::Json(c.get("/inbox/chats", &[])?),
        "xpanel_chat_messages" => {
            let chat = find_chat(c, &need("chat")?)?;
            let mut q = vec![("chat", chat["id"].as_str().unwrap_or("").to_string())];
            if a["unread"].as_bool().unwrap_or(false) {
                q.push(("unread", "1".into()));
            }
            if let Some(f) = s(a, "from") {
                q.push(("from", f.to_string()));
            }
            if let Some(t) = s(a, "to") {
                // 只写日期时包括当天
                q.push(("to", if t.len() <= 10 { format!("{t} 99:99") } else { t.to_string() }));
            }
            if let Some(k) = s(a, "q") {
                q.push(("q", k.to_string()));
            }
            q.push(("limit", a["limit"].as_u64().unwrap_or(500).to_string()));
            if s(a, "format") == Some("json") {
                Out::Json(c.get("/inbox/messages", &q)?)
            } else {
                let md = c.text("/inbox/markdown", &q)?;
                Out::Text(if md.trim().is_empty() {
                    format!("「{}」没有符合条件的消息。", chat["name"].as_str().unwrap_or(""))
                } else {
                    md
                })
            }
        }
        "xpanel_chat_mark_processed" => {
            let chat = find_chat(c, &need("chat")?)?;
            let id = chat["id"].as_str().unwrap_or("").to_string();
            let up_to = match s(a, "upTo") {
                Some(t) => t.to_string(),
                None => chat["last"]["time"].as_str().ok_or("这个聊天没有消息")?.to_string(),
            };
            Out::Json(c.send("PATCH", &format!("/inbox/chats/{}", enc(&id)), json!({"readUpTo": up_to}))?)
        }
        "xpanel_messages_to_item" => {
            let mut b = a.clone();
            if b.get("markRead").is_none() {
                b["markRead"] = json!(true);
            }
            Out::Json(c.send("POST", "/inbox/messages/to-item", b)?)
        }
        "xpanel_report" => {
            let id = match s(a, "itemId") {
                Some(i) => i.to_string(),
                None => crate::ws::item_of_cwd().ok_or("不在 xpanel 生成的项目里，请传 itemId")?,
            };
            let mut body = json!({"text": need("text")?, "status": s(a, "status").unwrap_or("working")});
            if let Some(f) = a.get("files").filter(|f| f.is_array()) {
                body["files"] = f.clone();
            }
            let it = c.send("POST", &format!("/items/{}/progress", enc(&id)), body)?;
            Out::Text(format!("已记到「{}」的 AI 进展（共 {} 条）", it["title"].as_str().unwrap_or(""), it["agentProgress"].as_array().map(|x| x.len()).unwrap_or(0)))
        }
        "xpanel_workspace_sync" => {
            let (dir, ch, images) = crate::ws::sync(c, s(a, "path"))?;
            Out::Json(json!({"project": dir.display().to_string(), "summary": ch.summary(images), "changes": ch,
                "hint": if ch.is_empty() { "没有新内容" } else { "新增内容已写进 .xpanel/，详见 .xpanel/更新记录.md 最后一条" }}))
        }
        "xpanel_workspace_create" => {
            let r = crate::ws::create(c, &need("itemId")?, s(a, "name"), s(a, "root"), s(a, "template").unwrap_or("general"), a["git"].as_bool().unwrap_or(true))?;
            Out::Json(json!({"project": r.path.display().to_string(), "summary": r.summary, "missing": r.missing,
                "next": "在这个目录里工作：先读 .xpanel/TASK.md"}))
        }
        "xpanel_add_qa" => {
            let id = match s(a, "itemId") {
                Some(i) => i.to_string(),
                None => crate::ws::item_of_cwd().ok_or("不在 xpanel 生成的项目里，请传 itemId")?,
            };
            let mut body = json!({"question": need("question")?, "answer": need("answer")?});
            if let Some(q) = s(a, "quote") {
                body["quote"] = json!(q);
            }
            let it = c.send("POST", &format!("/items/{}/qa", enc(&id)), body)?;
            Out::Text(format!("已挂到「{}」上（共 {} 条问答）", it["title"].as_str().unwrap_or(""), it["qa"].as_array().map(|x| x.len()).unwrap_or(0)))
        }
        "xpanel_audit" => {
            let mut q = vec![("limit", a["limit"].as_u64().unwrap_or(50).to_string())];
            if let Some(i) = s(a, "itemId") {
                q.push(("itemId", i.to_string()));
            }
            Out::Json(c.get("/audit", &q)?)
        }
        _ => return Err(format!("没有这个工具：{name}")),
    })
}

// ---------------------------------------------------------------- 协议

fn reply(id: &Value, result: Value) -> Value {
    json!({"jsonrpc":"2.0","id":id,"result":result})
}
fn error(id: &Value, code: i64, msg: &str) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":msg}})
}

/// 处理一条消息；通知（没有 id）返回 None
pub fn handle(c: &Client, msg: &Value) -> Option<Value> {
    let id = msg.get("id").cloned();
    let method = msg["method"].as_str().unwrap_or("");
    let Some(id) = id else {
        return None; // notifications/initialized、notifications/cancelled 等
    };
    if method.is_empty() {
        return Some(error(&id, -32600, "不是合法的请求"));
    }
    let p = &msg["params"];
    Some(match method {
        "initialize" => {
            let asked = p["protocolVersion"].as_str().unwrap_or("");
            let v = if PROTOCOL_VERSIONS.contains(&asked) {
                asked
            } else {
                PROTOCOL_VERSIONS[0]
            };
            reply(
                &id,
                json!({
                    "protocolVersion": v,
                    "capabilities": {"tools": {"listChanged": false}},
                    "serverInfo": {"name": "xpanel", "title": "xpanel 工作台", "version": env!("CARGO_PKG_VERSION")},
                    "instructions": INSTRUCTIONS
                }),
            )
        }
        "ping" => reply(&id, json!({})),
        "tools/list" => reply(&id, json!({"tools": tools()})),
        "tools/call" => {
            let name = p["name"].as_str().unwrap_or("");
            let args = p.get("arguments").cloned().unwrap_or(json!({}));
            match call(c, name, &args) {
                Ok(Out::Json(v)) => reply(
                    &id,
                    json!({"content":[{"type":"text","text": serde_json::to_string_pretty(&v).unwrap_or_default()}],"isError":false}),
                ),
                Ok(Out::Text(t)) => reply(
                    &id,
                    json!({"content":[{"type":"text","text": t}],"isError":false}),
                ),
                // 工具本身出错（参数不对、找不到、连不上）按 MCP 约定放在结果里，让 AI 看到原因
                Err(e) => reply(
                    &id,
                    json!({"content":[{"type":"text","text": e}],"isError":true}),
                ),
            }
        }
        "resources/list" => reply(&id, json!({"resources": []})),
        "prompts/list" => reply(&id, json!({"prompts": []})),
        _ => error(&id, -32601, &format!("不支持的方法：{method}")),
    })
}

pub fn serve(c: &Client) -> Result<(), String> {
    eprintln!("xpanel MCP 已启动，连接 {}", c.base);
    let stdin = std::io::stdin();
    let mut out = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let line = line.map_err(|e| e.to_string())?;
        if line.trim().is_empty() {
            continue;
        }
        let resp = match serde_json::from_str::<Value>(&line) {
            Err(_) => Some(error(&Value::Null, -32700, "JSON 格式不对")),
            Ok(Value::Array(batch)) => {
                let r: Vec<Value> = batch.iter().filter_map(|m| handle(c, m)).collect();
                (!r.is_empty()).then_some(Value::Array(r))
            }
            Ok(m) => handle(c, &m),
        };
        if let Some(r) = resp {
            writeln!(out, "{r}").map_err(|e| e.to_string())?;
            out.flush().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn client() -> Client {
        // 指向一个没人监听的端口：只测协议本身
        Client {
            base: "http://127.0.0.1:9".into(),
            key: None,
            actor: Some("test".into()),
        }
    }

    #[test]
    fn handshake_and_list() {
        let c = client();
        let r = handle(&c, &json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"t","version":"1"}}})).unwrap();
        assert_eq!(r["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(r["result"]["serverInfo"]["name"], "xpanel");
        let r = handle(&c, &json!({"jsonrpc":"2.0","id":2,"method":"initialize","params":{"protocolVersion":"1999-01-01"}})).unwrap();
        assert_eq!(r["result"]["protocolVersion"], PROTOCOL_VERSIONS[0]);
        assert!(handle(
            &c,
            &json!({"jsonrpc":"2.0","method":"notifications/initialized"})
        )
        .is_none());
        let r = handle(&c, &json!({"jsonrpc":"2.0","id":"a","method":"tools/list"})).unwrap();
        let tools = r["result"]["tools"].as_array().unwrap();
        assert!(tools.len() >= 15);
        for t in tools {
            let n = t["name"].as_str().unwrap();
            assert!(n.starts_with("xpanel_") && n.len() <= 64, "{n}");
            assert_eq!(t["inputSchema"]["type"], "object", "{n}");
            assert!(!t["description"].as_str().unwrap().is_empty());
        }
        let r = handle(&c, &json!({"jsonrpc":"2.0","id":3,"method":"nope"})).unwrap();
        assert_eq!(r["error"]["code"], -32601);
    }

    #[test]
    fn tool_errors_are_results() {
        let c = client();
        let r = handle(&c, &json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"xpanel_get_item","arguments":{}}})).unwrap();
        assert_eq!(r["result"]["isError"], true);
        assert!(r["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("缺少参数 id"));
        let r = handle(&c, &json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"xpanel_stats","arguments":{}}})).unwrap();
        assert_eq!(r["result"]["isError"], true); // 连不上
        let r = handle(&c, &json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"xx","arguments":{}}})).unwrap();
        assert_eq!(r["result"]["isError"], true);
    }
}
