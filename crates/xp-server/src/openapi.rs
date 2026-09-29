//! /api/v1/openapi.json：给外部 AI 和工具读的接口说明（手写，改接口时同步改这里；测试会检查路由都在）

use serde_json::{json, Value};

fn q(name: &str, desc: &str) -> Value {
    json!({ "name": name, "in": "query", "required": false, "schema": { "type": "string" }, "description": desc })
}

fn filters() -> Vec<Value> {
    vec![
        q("type", "类型，逗号分隔：todo,issue,idea,note,link,rule"),
        q("status", "open（未完成）/ done（已完成）/ all（默认）"),
        q("tag", "标签（不带 #）"),
        q(
            "category",
            "分类路径，如 工作/AutoSAR（包括子分类）；none 表示未分类",
        ),
        q("priority", "优先级，逗号分隔：P0,P1,P2,P3,none"),
        q("q", "关键词，搜标题和正文；多个词用空格隔开表示都要包含"),
        q("device", "设备名"),
    ]
}

fn id_param() -> Value {
    json!({ "name": "id", "in": "path", "required": true, "schema": { "type": "string" } })
}

/// 文档里列出的路径（测试会逐个检查路由确实存在）
#[cfg_attr(not(test), allow(dead_code))]
pub const PATHS: &[&str] = &[
    "/meta",
    "/items",
    "/items/reprioritize",
    "/items/{id}",
    "/items/{id}/progress",
    "/items/{id}/qa",
    "/templates",
    "/export",
    "/stats",
    "/audit",
    "/events",
    "/devices",
    "/devices/{id}",
    "/devices/heartbeat",
    "/categories",
    "/categories/rename",
    "/tags",
    "/tags/rename",
    "/inbox/wechat/preview",
    "/inbox/wechat/import",
    "/inbox/chats",
    "/inbox/chats/{id}",
    "/inbox/chats/{id}/bundles",
    "/inbox/messages",
    "/inbox/messages/delete",
    "/inbox/messages/to-item",
    "/inbox/markdown",
    "/inbox/me",
];

pub fn spec() -> Value {
    let mut list_params = filters();
    list_params.push(json!({ "name": "limit", "in": "query", "schema": { "type": "integer", "default": 200, "maximum": 5000 } }));
    list_params.push(
        json!({ "name": "offset", "in": "query", "schema": { "type": "integer", "default": 0 } }),
    );
    let mut export_params = filters();
    export_params.insert(0, json!({ "name": "format", "in": "query", "schema": { "type": "string", "enum": ["md", "csv", "json"], "default": "md" } }));
    let err = json!({ "description": "出错时返回 {\"error\": \"说明\"}；400 请求有误，401 key 不对，404 找不到，503 暂时存不了（可稍后重试）" });

    let mut v = json!({
        "openapi": "3.0.3",
        "info": {
            "title": "xpanel API",
            "version": env!("CARGO_PKG_VERSION"),
            "description": "xpanel 个人工作台的对外接口：读写待办 / 问题 / 灵感 / 笔记，整理优先级，导出和统计。\n\n\
    身份：请求头 `Authorization: Bearer <key>`（用 `xp key create <名字>` 生成）。没有 key 时可用 `X-Actor: <名字>` 标明来源。所有写入都会记录是谁改的。\n\n\
    时间字段是毫秒时间戳；`due` 是 YYYY-MM-DD；`priority` 是 P0（最急）到 P3。"
        },
        "servers": [{ "url": "/api/v1" }],
        "components": {
            "securitySchemes": { "key": { "type": "http", "scheme": "bearer" } },
            "schemas": {
                "Item": {
                    "type": "object",
                    "description": "条目。除下列字段外还可以有任意自定义字段，会原样保存。",
                    "properties": {
                        "id": { "type": "string" },
                        "type": { "type": "string", "enum": ["todo", "issue", "idea", "note", "link", "rule", "inbox"], "description": "inbox 是随手发进收件箱、还没归类的" },
                        "title": { "type": "string" },
                        "body": { "type": "string", "description": "Markdown 正文" },
                        "tags": { "type": "array", "items": { "type": "string" } },
                        "category": { "type": "string", "description": "分类路径，用 / 分层，如 工作/AutoSAR" },
                        "priority": { "type": "string", "enum": ["P0", "P1", "P2", "P3"] },
                        "due": { "type": "string", "format": "date" },
                        "rank": { "type": "number", "description": "手动排序，越小越靠前" },
                        "done": { "type": "boolean" },
                        "pinned": { "type": "boolean" },
                        "device": { "type": "string" },
                        "createdAt": { "type": "number" },
                        "updatedAt": { "type": "number" },
                        "doneAt": { "type": "number" },
                        "createdBy": { "type": "string" }
                    }
                },
                "Device": {
                    "type": "object",
                    "properties": {
                        "name": { "type": "string" },
                        "kind": { "type": "string", "enum": ["desktop", "laptop", "mac", "server", "nas", "phone", "other"] },
                        "description": { "type": "string" },
                        "aliases": { "type": "array", "items": { "type": "string" }, "description": "别名，也用于 @ 提及和按主机名匹配入口" },
                        "networks": { "type": "array", "items": { "type": "object", "properties": { "name": { "type": "string" }, "ip": { "type": "string" }, "note": { "type": "string" } } }, "description": "各局域网里的地址；心跳上报同网段的新地址时自动更新" },
                        "projects": { "type": "array", "items": { "type": "object", "properties": { "name": { "type": "string" }, "path": { "type": "string" }, "agent": { "type": "string" }, "note": { "type": "string" } } }, "description": "这台电脑上的项目，消息分发的目标" },
                        "lastSeen": { "type": "number", "readOnly": true },
                        "hostname": { "type": "string", "readOnly": true },
                        "reportedIps": { "type": "array", "readOnly": true, "items": { "type": "object" } }
                    }
                },
                "NewItem": {
                    "type": "object",
                    "required": ["title"],
                    "properties": {
                        "id": { "type": "string", "description": "可选。传了就是幂等写入：重复提交同一个 id 只更新，不会多出一条" },
                        "type": { "type": "string", "default": "todo" },
                        "title": { "type": "string" },
                        "body": { "type": "string" },
                        "tags": { "type": "array", "items": { "type": "string" } },
                        "category": { "type": "string", "description": "分类路径，如 工作/AutoSAR" },
                        "priority": { "type": "string", "description": "P0–P3，也接受 urgent/high/medium/low 或 紧急/高/中/低" },
                        "due": { "type": "string", "format": "date" },
                        "rank": { "type": "number" },
                        "pinned": { "type": "boolean" },
                        "device": { "type": "string" }
                    }
                }
            }
        },
        "security": [{ "key": [] }, {}],
        "paths": {
            "/meta": { "get": { "summary": "服务信息、条目类型、当前 rev", "responses": { "200": { "description": "ok" } } } },
            "/items": {
                "get": { "summary": "查询条目", "description": "排序：置顶 → 优先级 → rank → 最近更新。返回 {total, count, items}。", "parameters": list_params, "responses": { "200": { "description": "ok" }, "400": err } },
                "post": {
                    "summary": "新建条目（一条对象或多条数组）",
                    "requestBody": { "required": true, "content": { "application/json": { "schema": { "oneOf": [
                        { "$ref": "#/components/schemas/NewItem" },
                        { "type": "array", "items": { "$ref": "#/components/schemas/NewItem" } }
                    ] } } } },
                    "responses": { "201": { "description": "传对象返回条目，传数组返回 {items}" }, "400": err }
                }
            },
            "/items/reprioritize": {
                "post": {
                    "summary": "批量调整优先级 / 排序",
                    "description": "先用 dryRun=true 看对比，确认后再提交；任一条不合法则整批不生效。每条的 reason 会写进操作记录。",
                    "requestBody": { "required": true, "content": { "application/json": { "schema": {
                        "type": "object", "required": ["changes"],
                        "properties": {
                            "dryRun": { "type": "boolean", "default": false },
                            "changes": { "type": "array", "items": { "type": "object", "required": ["id"], "properties": {
                                "id": { "type": "string" },
                                "priority": { "type": "string", "nullable": true, "description": "P0–P3；null 表示清除" },
                                "rank": { "type": "number" },
                                "reason": { "type": "string" }
                            } } }
                        }
                    } } } },
                    "responses": { "200": { "description": "{dryRun, applied, changes:[{id,title,from,to,reason}]}" }, "400": err }
                }
            },
            "/items/{id}": {
                "get": { "summary": "读取一条", "parameters": [id_param()], "responses": { "200": { "description": "ok" }, "404": err } },
                "patch": {
                    "summary": "按字段修改（值为 null 表示删除该字段）",
                    "description": "例：{\"done\": true} 标记完成；{\"priority\": \"P1\", \"due\": \"2026-10-08\"}。",
                    "parameters": [id_param()],
                    "requestBody": { "required": true, "content": { "application/json": { "schema": { "type": "object" } } } },
                    "responses": { "200": { "description": "修改后的条目" }, "400": err, "404": err }
                },
                "delete": { "summary": "删除（软删除，可在操作记录里找回内容）", "parameters": [id_param()], "responses": { "204": { "description": "已删除" }, "404": err } }
            },
            "/export": { "get": { "summary": "导出。md 适合交给 AI 读（每条带 <!-- id:… -->），csv 给表格软件，json 给程序", "parameters": export_params, "responses": { "200": { "description": "导出内容" } } } },
            "/stats": { "get": { "summary": "统计：按类型、优先级、标签、设备的数量，逾期、长期未动的条目，最近 8 周新建 / 完成数", "parameters": filters(), "responses": { "200": { "description": "ok" } } } },
            "/audit": { "get": { "summary": "操作记录（谁在什么时候改了什么），最新的在前", "parameters": [
                { "name": "limit", "in": "query", "schema": { "type": "integer", "default": 100 } },
                { "name": "itemId", "in": "query", "schema": { "type": "string" } }
            ], "responses": { "200": { "description": "{entries}" } } } },
            "/categories": {
                "get": { "summary": "分类列表：path、depth、direct（本分类条数）、total / open（含子分类）、explicit（手工建的）", "responses": { "200": { "description": "{categories}" } } },
                "post": { "summary": "新建（空）分类", "requestBody": { "required": true, "content": { "application/json": { "schema": { "type": "object", "required": ["path"], "properties": { "path": { "type": "string", "example": "工作/AutoSAR" } } } } } }, "responses": { "201": { "description": "{path}" }, "400": err.clone() } },
                "delete": { "summary": "删除分类和它的子分类", "parameters": [q("path", "分类路径"), q("moveTo", "parent（默认，条目移到上一级）/ none（条目变成未分类）")], "responses": { "200": { "description": "{changed}" } } }
            },
            "/categories/rename": { "post": { "summary": "分类改名或移动（子分类一起；目标已存在就合并）", "requestBody": { "required": true, "content": { "application/json": { "schema": { "type": "object", "required": ["from", "to"], "properties": { "from": { "type": "string" }, "to": { "type": "string" } } } } } }, "responses": { "200": { "description": "{changed}" }, "400": err.clone(), "404": err.clone() } } },
            "/tags": {
                "get": { "summary": "标签列表（按使用次数排序）：tag、total、open", "responses": { "200": { "description": "{tags}" } } },
                "delete": { "summary": "从所有条目上去掉一个标签", "parameters": [q("tag", "标签")], "responses": { "200": { "description": "{changed}" } } }
            },
            "/tags/rename": { "post": { "summary": "标签改名；新名字已在用就合并", "requestBody": { "required": true, "content": { "application/json": { "schema": { "type": "object", "required": ["from", "to"], "properties": { "from": { "type": "string" }, "to": { "type": "string" } } } } } }, "responses": { "200": { "description": "{changed}" }, "400": err.clone(), "404": err.clone() } } },
            "/devices": {
                "get": { "summary": "设备列表（名字、类型、描述、各局域网地址、项目、最后在线时间、上报的 IP 和已装的 AI 命令行）", "responses": { "200": { "description": "{devices}" } } },
                "post": {
                    "summary": "新建设备",
                    "description": "名字唯一，不能有空格、@、#。条目的 device 字段存的是设备名字。",
                    "requestBody": { "required": true, "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Device" } } } },
                    "responses": { "201": { "description": "新建的设备" }, "400": err.clone() }
                }
            },
            "/devices/{id}": {
                "get": { "summary": "读取一台设备", "parameters": [id_param()], "responses": { "200": { "description": "ok" }, "404": err.clone() } },
                "patch": { "summary": "修改设备（改名时，条目里的旧名字会一起改掉）", "parameters": [id_param()], "requestBody": { "required": true, "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Device" } } } }, "responses": { "200": { "description": "修改后的设备" }, "400": err.clone(), "404": err.clone() } },
                "delete": { "summary": "删除设备（条目里的设备名保留为普通文字）", "parameters": [id_param()], "responses": { "204": { "description": "已删除" } } }
            },
            "/devices/heartbeat": { "post": { "summary": "桌面版每分钟上报一次：主机名、系统、IP、版本、已装的 AI 命令行", "responses": { "200": { "description": "设备记录" } } } },
            "/events": { "get": { "summary": "SSE：先发 hello，之后每次数据变化发 change，data 为 {\"rev\": n}", "responses": { "200": { "description": "text/event-stream" } } } }
        }
    });
    if let (Some(p), Value::Object(more)) = (v["paths"].as_object_mut(), inbox_paths(&err)) {
        p.extend(more);
    }
    v
}

/// 收件箱的接口（单独写，json! 宏一次展开不了太长）
fn inbox_paths(err: &Value) -> Value {
    json!({
            "/items/{id}/progress": { "post": {
                "summary": "AI 回写进展：追加到条目的 agentProgress（显示在条目的「AI 进展」里，最多保留 50 条）",
                "parameters": [{ "name": "id", "in": "path", "required": true, "schema": { "type": "string" } }],
                "requestBody": { "required": true, "content": { "application/json": { "schema": { "type": "object", "required": ["text"], "properties": {
                    "text": { "type": "string", "description": "做了什么、结论、还缺什么（Markdown）" },
                    "status": { "type": "string", "enum": ["working", "done", "blocked"], "default": "working" },
                    "files": { "type": "array", "items": { "type": "string" }, "description": "相关产出文件的路径" } } } } } },
                "responses": { "201": { "description": "更新后的条目" }, "400": err.clone(), "404": err.clone() } } },
            "/items/{id}/qa": { "post": {
                "summary": "往笔记上挂一条问答（显示在原文旁边）。quote 是提问针对的原文，要原样摘抄；不填表示针对整篇",
                "parameters": [{ "name": "id", "in": "path", "required": true, "schema": { "type": "string" } }],
                "requestBody": { "required": true, "content": { "application/json": { "schema": { "type": "object", "required": ["question", "answer"], "properties": {
                    "quote": { "type": "string" }, "question": { "type": "string" }, "answer": { "type": "string", "description": "Markdown" } } } } } },
                "responses": { "201": { "description": "更新后的条目" }, "400": err.clone(), "404": err.clone() } } },
            "/templates": {
                "get": { "summary": "交给 AI 的任务模板（id、名字、目标、开场提示词、继续时的提示）", "responses": { "200": { "description": "{templates}" } } },
                "put": { "summary": "整体替换任务模板；传空数组恢复内置的", "responses": { "200": { "description": "{templates}" }, "400": err.clone() } }
            },
            "/inbox/wechat/preview": { "post": {
                "summary": "预览一份微信聊天记录导出（合并转发 → 导出的 ZIP）：条数、时间范围、发送人、像是哪个已有聊天、其中多少条已经导入过",
                "description": "请求体可以直接是 ZIP 文件内容（Content-Type: application/zip），也可以是 JSON {data: base64, name}。",
                "requestBody": { "required": true, "content": { "application/zip": {}, "application/json": { "schema": { "type": "object", "properties": { "data": { "type": "string" }, "name": { "type": "string" } } } } } },
                "responses": { "200": { "description": "{count, start, end, senders, files, missing, suggestedChat, matchedChat}" }, "400": err.clone() } } },
            "/inbox/wechat/import": { "post": {
                "summary": "导入微信聊天记录导出到某个聊天（按聊天名；没有就新建）。重复的消息自动跳过，附件存进 assets",
                "parameters": [q("chat", "聊天名（微信导出里没有群名，需要自己给）；不填就用预览建议的名字"), q("name", "原始文件名，记在导入记录里")],
                "requestBody": { "required": true, "content": { "application/zip": {}, "application/json": { "schema": { "type": "object", "properties": { "data": { "type": "string" }, "name": { "type": "string" }, "chat": { "type": "string" } } } } } },
                "responses": { "201": { "description": "{chat, bundle, total, added, duplicates}" }, "400": err.clone() } } },
            "/inbox/chats": { "get": { "summary": "聊天列表：消息数、未处理数（readUpTo 之后的）、最后一条", "responses": { "200": { "description": "{chats}" } } } },
            "/inbox/chats/{id}": {
                "get": { "summary": "读取一个聊天", "parameters": [id_param()], "responses": { "200": { "description": "ok" }, "404": err.clone() } },
                "patch": { "summary": "修改聊天：name（改成已有的名字就合并过去）、readUpTo（已处理到的时间，如 2026-09-29 16:03；null 清掉）、note", "parameters": [id_param()], "responses": { "200": { "description": "修改后的聊天（合并时是合并到的那个）" }, "400": err.clone(), "404": err.clone() } },
                "delete": { "summary": "删除聊天和它的消息", "parameters": [id_param()], "responses": { "204": { "description": "已删除" } } }
            },
            "/inbox/chats/{id}/bundles": { "get": { "summary": "这个聊天的导入记录（每次导入的文件名、时间范围、新增条数、正文里没提到的附件）", "parameters": [id_param()], "responses": { "200": { "description": "{bundles}" } } } },
            "/inbox/messages": { "get": {
                "summary": "查消息，按时间从早到晚。分页从最新往前数：offset 跳过最新的几条",
                "parameters": [q("chat", "聊天 id"), q("q", "关键词"), q("from", "起始时间 YYYY-MM-DD HH:MM（含）"), q("to", "结束时间（含）"), q("ids", "消息 id，逗号分隔"), q("unread", "true：只要「已处理到」之后的"),
                    json!({ "name": "limit", "in": "query", "schema": { "type": "integer", "default": 500 } }), json!({ "name": "offset", "in": "query", "schema": { "type": "integer", "default": 0 } })],
                "responses": { "200": { "description": "{total, count, messages:[{id, chatId, time, sender, text, attachments:[{kind, name, asset, missing}]}]}" } } } },
            "/inbox/messages/delete": { "post": { "summary": "删除消息（再导入同样的消息也不会回来）", "requestBody": { "required": true, "content": { "application/json": { "schema": { "type": "object", "properties": { "ids": { "type": "array", "items": { "type": "string" } } } } } } }, "responses": { "200": { "description": "{deleted}" } } } },
            "/inbox/messages/to-item": { "post": {
                "summary": "把选中的消息整理成一条事项或笔记（正文是按天分节的 Markdown，图片直接显示）",
                "requestBody": { "required": true, "content": { "application/json": { "schema": { "type": "object", "required": ["ids"], "properties": {
                    "ids": { "type": "array", "items": { "type": "string" } }, "type": { "type": "string", "default": "note" }, "title": { "type": "string" },
                    "category": { "type": "string" }, "tags": { "type": "array", "items": { "type": "string" }, "default": ["微信"] }, "priority": { "type": "string" }, "due": { "type": "string" },
                    "markRead": { "type": "boolean", "description": "同时把聊天标成已处理到这些消息" } } } } } },
                "responses": { "201": { "description": "新建的条目" }, "400": err.clone(), "404": err.clone() } } },
            "/inbox/markdown": { "get": { "summary": "消息导出成 Markdown（参数同 /inbox/messages），适合交给 AI 读", "parameters": [q("chat", "聊天 id"), q("ids", "消息 id，逗号分隔"), q("from", "起始时间"), q("to", "结束时间"), q("unread", "true：只要未处理的")], "responses": { "200": { "description": "text/markdown" } } } },
            "/inbox/me": {
                "get": { "summary": "哪些发送人是「我」", "responses": { "200": { "description": "{me}" } } },
                "put": { "summary": "设置哪些发送人是「我」", "requestBody": { "required": true, "content": { "application/json": { "schema": { "type": "object", "properties": { "me": { "type": "array", "items": { "type": "string" } } } } } } }, "responses": { "200": { "description": "{me}" } } }
            }
    })
}
