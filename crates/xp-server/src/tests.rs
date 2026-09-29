use super::*;
use axum::body::Body;
use axum::http::{Method, Request};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use std::path::PathBuf;
use tower::ServiceExt;

fn setup(name: &str) -> (Arc<Store>, PathBuf) {
    let d = std::env::temp_dir().join(format!("xp-server-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    (Arc::new(Store::open(&d).unwrap()), d)
}

async fn call(
    st: &Arc<Store>,
    method: Method,
    uri: &str,
    body: Option<Value>,
    headers: &[(&str, &str)],
) -> (StatusCode, String) {
    let mut b = Request::builder().method(method).uri(uri);
    for (k, v) in headers {
        b = b.header(*k, *v);
    }
    let req = match body {
        Some(v) => b
            .header("content-type", "application/json")
            .body(Body::from(v.to_string()))
            .unwrap(),
        None => b.body(Body::empty()).unwrap(),
    };
    let resp = router(st.clone()).oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    (status, String::from_utf8_lossy(&bytes).to_string())
}

fn j(s: &str) -> Value {
    serde_json::from_str(s).unwrap_or(Value::Null)
}

#[tokio::test]
async fn legacy_api_still_works() {
    let (st, d) = setup("legacy");
    let (c, html) = call(&st, Method::GET, "/", None, &[]).await;
    assert_eq!(c, StatusCode::OK);
    assert!(html.contains("wb-ui-version"));
    let (c, _) = call(&st, Method::GET, "/vendor/marked.js", None, &[]).await;
    assert_eq!(c, StatusCode::OK);
    // 旧界面用 text/plain 发操作
    let op =
        json!({"kind":"upsert","item":{"id":"a","type":"todo","title":"旧界面写的","updatedAt":1}});
    let req = Request::post("/api/op")
        .header("content-type", "text/plain;charset=utf-8")
        .body(Body::from(op.to_string()))
        .unwrap();
    let resp = router(st.clone()).oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let (_, s) = call(&st, Method::GET, "/api/state", None, &[]).await;
    let s = j(&s);
    assert_eq!(s["items"][0]["title"], "旧界面写的");
    let (_, r) = call(&st, Method::GET, "/api/rev", None, &[]).await;
    assert_eq!(j(&r)["rev"], s["rev"]);
    // 缺 id 是 400（客户端不重试）
    let (c, e) = call(
        &st,
        Method::POST,
        "/api/op",
        Some(json!({"kind":"upsert","item":{"title":"x"}})),
        &[],
    )
    .await;
    assert_eq!(c, StatusCode::BAD_REQUEST);
    assert!(j(&e)["error"].as_str().unwrap().contains("id"));
    // 附件
    let (c, n) = call(
        &st,
        Method::POST,
        "/api/asset",
        Some(json!({"name":"p-1.png","data":"aGk="})),
        &[],
    )
    .await;
    assert_eq!(
        (c, j(&n)["name"].as_str()),
        (StatusCode::OK, Some("p-1.png"))
    );
    let (c, body) = call(&st, Method::GET, "/api/asset/p-1.png", None, &[]).await;
    assert_eq!((c, body.as_str()), (StatusCode::OK, "hi"));
    // 大截图（几 MB）也能传：axum 默认只收 2MB，这里要放开
    let big = "A".repeat(8 * 1024 * 1024);
    let (c, _) = call(
        &st,
        Method::POST,
        "/api/asset",
        Some(json!({"name":"big-1.png","data":big})),
        &[],
    )
    .await;
    assert_eq!(c, StatusCode::OK);
    assert_eq!(st.get_asset("big-1.png").unwrap().len(), 6 * 1024 * 1024);
    let (c, _) = call(&st, Method::GET, "/api/asset/..%2Fx", None, &[]).await;
    assert_eq!(c, StatusCode::BAD_REQUEST);
    let (_, p) = call(&st, Method::GET, "/api/ping", None, &[]).await;
    assert_eq!(j(&p)["ok"], true);
    let _ = std::fs::remove_dir_all(d);
}

#[tokio::test]
async fn v1_items_crud_and_attribution() {
    let (st, d) = setup("v1");
    let key = st.create_key("claude-code").unwrap();
    let auth = format!("Bearer {key}");
    let (c, v) = call(
        &st,
        Method::POST,
        "/api/v1/items",
        Some(json!({"title":"整理客户反馈","priority":"high","tags":["客户"],"due":"2026-10-08"})),
        &[("authorization", &auth)],
    )
    .await;
    assert_eq!(c, StatusCode::CREATED);
    let it = j(&v);
    assert_eq!(it["priority"], "P1");
    assert_eq!(it["createdBy"], "claude-code");
    let id = it["id"].as_str().unwrap().to_string();
    // 批量
    let (c, v) = call(
        &st,
        Method::POST,
        "/api/v1/items",
        Some(json!([{"title":"A","type":"issue"},{"title":"B","type":"note","body":"笔记内容"}])),
        &[("x-actor", "codex")],
    )
    .await;
    assert_eq!(c, StatusCode::CREATED);
    assert_eq!(j(&v)["items"][0]["createdBy"], "codex");
    // 批量里有一条错，整批不写
    let (c, e) = call(
        &st,
        Method::POST,
        "/api/v1/items",
        Some(json!([{"title":"ok"},{"title":""}])),
        &[],
    )
    .await;
    assert_eq!(c, StatusCode::BAD_REQUEST);
    assert!(j(&e)["error"].as_str().unwrap().starts_with("第 2 条"));
    let (_, v) = call(
        &st,
        Method::GET,
        "/api/v1/items?type=todo,issue&status=open",
        None,
        &[],
    )
    .await;
    assert_eq!(j(&v)["total"], 2);
    let (_, v) = call(&st, Method::GET, "/api/v1/items?q=客户反馈", None, &[]).await;
    assert_eq!(j(&v)["items"][0]["id"], id.as_str());
    // 修改、完成
    let (c, v) = call(
        &st,
        Method::PATCH,
        &format!("/api/v1/items/{id}"),
        Some(json!({"done":true,"priority":null})),
        &[("authorization", &auth)],
    )
    .await;
    assert_eq!(c, StatusCode::OK);
    assert_eq!(j(&v)["done"], true);
    assert!(j(&v).get("priority").is_none());
    let (c, _) = call(
        &st,
        Method::PATCH,
        "/api/v1/items/nope",
        Some(json!({"done":true})),
        &[],
    )
    .await;
    assert_eq!(c, StatusCode::NOT_FOUND);
    // 错的 key 被拒绝
    let (c, _) = call(
        &st,
        Method::POST,
        "/api/v1/items",
        Some(json!({"title":"x"})),
        &[("authorization", "Bearer xp_bad")],
    )
    .await;
    assert_eq!(c, StatusCode::UNAUTHORIZED);
    let (c, _) = call(
        &st,
        Method::GET,
        "/api/v1/items",
        None,
        &[("authorization", "Bearer xp_bad")],
    )
    .await;
    assert_eq!(c, StatusCode::UNAUTHORIZED);
    // 操作记录写明是谁
    let (_, v) = call(
        &st,
        Method::GET,
        &format!("/api/v1/audit?itemId={id}"),
        None,
        &[],
    )
    .await;
    let e = j(&v);
    assert_eq!(e["entries"][0]["actor"], "claude-code");
    assert_eq!(e["entries"][0]["action"], "update");
    let (c, _) = call(
        &st,
        Method::DELETE,
        &format!("/api/v1/items/{id}"),
        None,
        &[],
    )
    .await;
    assert_eq!(c, StatusCode::NO_CONTENT);
    let (c, _) = call(&st, Method::GET, &format!("/api/v1/items/{id}"), None, &[]).await;
    assert_eq!(c, StatusCode::NOT_FOUND);
    let _ = std::fs::remove_dir_all(d);
}

#[tokio::test]
async fn v1_reprioritize_export_stats() {
    let (st, d) = setup("v1b");
    call(
        &st,
        Method::POST,
        "/api/v1/items",
        Some(json!([{"id":"a","title":"A"},{"id":"b","title":"B","priority":"P3"}])),
        &[],
    )
    .await;
    let body = json!({"dryRun":true,"changes":[{"id":"b","priority":"P0","reason":"老板要"}]});
    let (c, v) = call(
        &st,
        Method::POST,
        "/api/v1/items/reprioritize",
        Some(body),
        &[],
    )
    .await;
    assert_eq!(c, StatusCode::OK);
    let v = j(&v);
    assert_eq!(v["applied"], false);
    assert_eq!(v["changes"][0]["from"]["priority"], "P3");
    assert_eq!(v["changes"][0]["to"]["priority"], "P0");
    let (_, it) = call(&st, Method::GET, "/api/v1/items/b", None, &[]).await;
    assert_eq!(j(&it)["priority"], "P3");
    let body = json!({"changes":[{"id":"b","priority":"P0"}]});
    call(
        &st,
        Method::POST,
        "/api/v1/items/reprioritize",
        Some(body),
        &[],
    )
    .await;
    let (_, v) = call(&st, Method::GET, "/api/v1/items", None, &[]).await;
    assert_eq!(j(&v)["items"][0]["id"], "b");
    // 导出
    let (c, md) = call(
        &st,
        Method::GET,
        "/api/v1/export?format=md&type=todo",
        None,
        &[],
    )
    .await;
    assert_eq!(c, StatusCode::OK);
    assert!(md.contains("<!-- id:b -->"));
    let (_, csv) = call(&st, Method::GET, "/api/v1/export?format=csv", None, &[]).await;
    assert!(csv.contains("P0"));
    let (_, js) = call(
        &st,
        Method::GET,
        "/api/v1/export?format=json&priority=P0",
        None,
        &[],
    )
    .await;
    assert_eq!(j(&js)["count"], 1);
    let (c, _) = call(&st, Method::GET, "/api/v1/export?format=pdf", None, &[]).await;
    assert_eq!(c, StatusCode::BAD_REQUEST);
    // 统计
    let (_, s) = call(&st, Method::GET, "/api/v1/stats", None, &[]).await;
    let s = j(&s);
    assert_eq!(s["total"], 2);
    assert_eq!(s["openByPriority"]["P0"], 1);
    let _ = std::fs::remove_dir_all(d);
}

#[tokio::test]
async fn openapi_lists_every_route() {
    let (st, d) = setup("spec");
    let (_, v) = call(&st, Method::GET, "/api/v1/openapi.json", None, &[]).await;
    let v = j(&v);
    for p in openapi::PATHS {
        assert!(v["paths"][p].is_object(), "openapi 缺少 {p}");
        if p.contains("events") {
            continue; // SSE 是无限流，在 real_socket_and_sse 里单独测
        }
        let real = p.replace("{id}", "x");
        let post_only = p.contains("reprioritize")
            || p.contains("heartbeat")
            || p.ends_with("/rename")
            || p.ends_with("/progress")
            || p.ends_with("/qa")
            || p.contains("/wechat/")
            || p.starts_with("/inbox/messages/");
        let m = if post_only { Method::POST } else { Method::GET };
        let (c, _) = call(&st, m, &format!("/api/v1{real}"), None, &[]).await;
        assert_ne!(c, StatusCode::METHOD_NOT_ALLOWED, "{p}");
        if !post_only && !p.contains("{id}") {
            assert_eq!(c, StatusCode::OK, "{p}");
        }
    }
    let (_, m) = call(&st, Method::GET, "/api/v1/meta", None, &[]).await;
    assert_eq!(j(&m)["apiVersion"], 1);
    let _ = std::fs::remove_dir_all(d);
}

#[tokio::test]
async fn real_socket_and_sse() {
    let (st, d) = setup("sock");
    let l = bind(0).unwrap();
    let port = l.local_addr().unwrap().port();
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    let h = tokio::spawn(serve(st.clone(), l, async {
        let _ = rx.await;
    }));
    // 端口被占用时马上报错
    assert!(bind(port).is_err());
    let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .unwrap();
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    s.write_all(b"GET /api/v1/events HTTP/1.1\r\nHost: x\r\n\r\n")
        .await
        .unwrap();
    let mut buf = vec![0u8; 4096];
    let n = s.read(&mut buf).await.unwrap();
    assert!(String::from_utf8_lossy(&buf[..n]).contains("text/event-stream"));
    st.apply_op(
        xp_core::Op::Upsert {
            item: json!({"id":"z","title":"t"}),
        },
        "ui",
    )
    .unwrap();
    let mut got = String::new();
    for _ in 0..5 {
        let n = tokio::time::timeout(std::time::Duration::from_secs(2), s.read(&mut buf))
            .await
            .unwrap()
            .unwrap();
        got += &String::from_utf8_lossy(&buf[..n]);
        if got.contains("event: change") {
            break;
        }
    }
    assert!(got.contains("event: change"), "{got}");
    let _ = tx.send(());
    drop(s);
    let _ = tokio::time::timeout(std::time::Duration::from_secs(3), h).await;
    let _ = std::fs::remove_dir_all(d);
}

#[tokio::test]
async fn v1_devices() {
    let (st, d) = setup("dev");
    let (c, v) = call(
        &st,
        Method::POST,
        "/api/v1/devices",
        Some(json!({"name":"BASE","kind":"desktop","description":"8TB 盘在这台"})),
        &[("x-actor", "ui")],
    )
    .await;
    assert_eq!(c, StatusCode::CREATED);
    let id = j(&v)["id"].as_str().unwrap().to_string();
    let (c, _) = call(
        &st,
        Method::POST,
        "/api/v1/devices",
        Some(json!({"name":"BASE"})),
        &[],
    )
    .await;
    assert_eq!(c, StatusCode::BAD_REQUEST);
    let (c, v) = call(
        &st,
        Method::PATCH,
        &format!("/api/v1/devices/{id}"),
        Some(json!({"networks":[{"name":"家里","ip":"192.168.1.20"}]})),
        &[],
    )
    .await;
    assert_eq!(c, StatusCode::OK);
    assert_eq!(j(&v)["networks"][0]["ip"], "192.168.1.20");
    let (c, _) = call(
        &st,
        Method::PATCH,
        &format!("/api/v1/devices/{id}"),
        Some(json!({"networks":[{"name":"家里","ip":"不是IP"}]})),
        &[],
    )
    .await;
    assert_eq!(c, StatusCode::BAD_REQUEST);
    let hb = json!({"id": id, "hostname":"BASE","os":"windows","ips":[{"ip":"192.168.1.23","iface":"以太网"}],"agentVersion":"0.2.0","aiTools":["claude","codex"],"isHost":true});
    let (c, v) = call(
        &st,
        Method::POST,
        "/api/v1/devices/heartbeat",
        Some(hb),
        &[],
    )
    .await;
    assert_eq!(c, StatusCode::OK);
    assert_eq!(j(&v)["networks"][0]["ip"], "192.168.1.23");
    let (_, v) = call(&st, Method::GET, "/api/v1/devices", None, &[]).await;
    assert_eq!(j(&v)["devices"][0]["aiTools"], json!(["claude", "codex"]));
    let (_, s) = call(&st, Method::GET, "/api/state", None, &[]).await;
    assert_eq!(j(&s)["devices"][0]["name"], "BASE");
    let (c, _) = call(
        &st,
        Method::DELETE,
        &format!("/api/v1/devices/{id}"),
        None,
        &[],
    )
    .await;
    assert_eq!(c, StatusCode::NO_CONTENT);
    let _ = std::fs::remove_dir_all(d);
}

#[tokio::test]
async fn v1_categories_and_tags() {
    let (st, d) = setup("cats");
    call(&st, Method::POST, "/api/v1/items", Some(json!([{"id":"a","title":"A","category":"工作 / AutoSAR","tags":["can"]},{"id":"b","title":"B","tags":["can","周报"]}])), &[]).await;
    let (_, v) = call(&st, Method::GET, "/api/v1/items/a", None, &[]).await;
    assert_eq!(j(&v)["category"], "工作/AutoSAR");
    let (c, _) = call(
        &st,
        Method::POST,
        "/api/v1/items",
        Some(json!({"title":"x","category":"a/b/c/d/e/f"})),
        &[],
    )
    .await;
    assert_eq!(c, StatusCode::BAD_REQUEST);
    let (_, v) = call(
        &st,
        Method::GET,
        "/api/v1/items?category=%E5%B7%A5%E4%BD%9C",
        None,
        &[],
    )
    .await;
    assert_eq!(j(&v)["total"], 1);
    let (c, _) = call(
        &st,
        Method::POST,
        "/api/v1/categories",
        Some(json!({"path":"学习/Rust"})),
        &[],
    )
    .await;
    assert_eq!(c, StatusCode::CREATED);
    let (_, v) = call(&st, Method::GET, "/api/v1/categories", None, &[]).await;
    assert_eq!(j(&v)["categories"].as_array().unwrap().len(), 4);
    let (_, v) = call(
        &st,
        Method::POST,
        "/api/v1/categories/rename",
        Some(json!({"from":"工作","to":"项目"})),
        &[],
    )
    .await;
    assert_eq!(j(&v)["changed"], 1);
    let (_, v) = call(
        &st,
        Method::PATCH,
        "/api/v1/items/b",
        Some(json!({"category":"项目"})),
        &[],
    )
    .await;
    assert_eq!(j(&v)["category"], "项目");
    let (_, v) = call(
        &st,
        Method::DELETE,
        "/api/v1/categories?path=%E9%A1%B9%E7%9B%AE&moveTo=none",
        None,
        &[],
    )
    .await;
    assert_eq!(j(&v)["changed"], 2);
    let (_, v) = call(&st, Method::GET, "/api/v1/tags", None, &[]).await;
    assert_eq!(j(&v)["tags"][0]["tag"], "can");
    let (_, v) = call(
        &st,
        Method::POST,
        "/api/v1/tags/rename",
        Some(json!({"from":"周报","to":"can"})),
        &[],
    )
    .await;
    assert_eq!(j(&v)["changed"], 1);
    let (_, v) = call(&st, Method::DELETE, "/api/v1/tags?tag=can", None, &[]).await;
    assert_eq!(j(&v)["changed"], 2);
    let (_, s) = call(&st, Method::GET, "/api/v1/stats", None, &[]).await;
    assert!(j(&s)["byCategory"].is_array());
    let _ = std::fs::remove_dir_all(d);
}

fn wechat_zip(txt: &str, files: &[(&str, &[u8])]) -> Vec<u8> {
    use std::io::Write;
    let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let o =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    w.start_file("聊天记录.txt", o).unwrap();
    w.write_all(txt.as_bytes()).unwrap();
    for (n, b) in files {
        w.start_file(format!("聊天记录内的图片、视频和文件/{n}"), o)
            .unwrap();
        w.write_all(b).unwrap();
    }
    w.finish().unwrap().into_inner()
}

async fn raw(st: &Arc<Store>, uri: &str, body: Vec<u8>) -> (StatusCode, String) {
    let req = Request::builder()
        .method(Method::POST)
        .uri(uri)
        .header("content-type", "application/zip")
        .body(Body::from(body))
        .unwrap();
    let resp = router(st.clone()).oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    (status, String::from_utf8_lossy(&bytes).to_string())
}

#[tokio::test]
async fn inbox_wechat_flow() {
    let (st, d) = setup("inbox");
    let txt = "·甲\n2026年9月8日 09:10\n看下这个\n\n·乙\n2026年9月8日 09:11\n[视频] v.mp4\n\n·甲\n2026年9月9日 10:00\n# 不是标题\n";
    // 视频 70MB：超过普通接口的 64MB 上限，导入接口要能收
    let big = vec![7u8; 70 * 1024 * 1024];
    let z = wechat_zip(txt, &[("v.mp4", &big)]);
    let (c, v) = raw(&st, "/api/v1/inbox/wechat/preview", z.clone()).await;
    assert_eq!(c, StatusCode::OK, "{v}");
    assert_eq!(j(&v)["count"], 3);
    let (c, v) = raw(
        &st,
        "/api/v1/inbox/wechat/import?chat=%E9%A1%B9%E7%9B%AE%E7%BE%A4&name=x.zip",
        z,
    )
    .await;
    assert_eq!(c, StatusCode::CREATED, "{v}");
    let r = j(&v);
    assert_eq!(r["added"], 3);
    assert_eq!(r["chat"]["name"], "项目群");
    let chat = r["chat"]["id"].as_str().unwrap().to_string();

    // JSON + base64 的写法（界面用）
    use base64::Engine;
    let small = wechat_zip("·丙\n2026年9月10日 08:00\n早\n", &[]);
    let b64 = base64::engine::general_purpose::STANDARD.encode(&small);
    let (c, v) = call(
        &st,
        Method::POST,
        "/api/v1/inbox/wechat/import",
        Some(json!({"data": b64, "name": "y.zip"})),
        &[],
    )
    .await;
    assert_eq!(c, StatusCode::CREATED, "{v}");
    assert_eq!(j(&v)["chat"]["name"], "丙");

    let (c, v) = raw(&st, "/api/v1/inbox/wechat/preview", b"nope".to_vec()).await;
    assert_eq!(c, StatusCode::BAD_REQUEST, "{v}");

    let (_, v) = call(&st, Method::GET, "/api/v1/inbox/chats", None, &[]).await;
    assert_eq!(j(&v)["chats"].as_array().unwrap().len(), 2);

    let (_, v) = call(
        &st,
        Method::GET,
        &format!("/api/v1/inbox/messages?chat={chat}"),
        None,
        &[],
    )
    .await;
    let v = j(&v);
    assert_eq!(v["total"], 3);
    let asset = v["messages"][1]["attachments"][0]["asset"]
        .as_str()
        .unwrap()
        .to_string();
    let ids: Vec<String> = v["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["id"].as_str().unwrap().to_string())
        .collect();

    let (c, md) = call(
        &st,
        Method::GET,
        &format!("/api/v1/inbox/markdown?ids={}", ids.join(",")),
        None,
        &[],
    )
    .await;
    assert_eq!(c, StatusCode::OK);
    assert!(md.contains("\\# 不是标题"), "{md}");
    assert!(md.contains(&format!("[v.mp4](asset:{asset})")));

    let (c, v) = call(
        &st,
        Method::POST,
        "/api/v1/inbox/messages/to-item",
        Some(json!({"ids": ids[..2], "type": "todo", "priority": "P1", "markRead": true})),
        &[("x-actor", "测试")],
    )
    .await;
    assert_eq!(c, StatusCode::CREATED, "{v}");
    let it = j(&v);
    assert_eq!(it["type"], "todo");
    assert_eq!(it["title"], "项目群 · 2026-09-08 09:10");
    assert_eq!(it["tags"], json!(["微信"]));
    assert_eq!(it["source"]["messageIds"].as_array().unwrap().len(), 2);
    assert!(it["body"].as_str().unwrap().starts_with(">"));
    let (_, v) = call(
        &st,
        Method::GET,
        &format!("/api/v1/inbox/chats/{chat}"),
        None,
        &[],
    )
    .await;
    assert_eq!(j(&v)["readUpTo"], "2026-09-08 09:11");
    let (_, v) = call(
        &st,
        Method::GET,
        &format!("/api/v1/inbox/messages?chat={chat}&unread=1"),
        None,
        &[],
    )
    .await;
    assert_eq!(j(&v)["total"], 1);

    let (c, _) = call(
        &st,
        Method::PUT,
        "/api/v1/inbox/me",
        Some(json!({"me": ["甲"]})),
        &[],
    )
    .await;
    assert_eq!(c, StatusCode::OK);
    let (c, v) = call(
        &st,
        Method::POST,
        "/api/v1/inbox/messages/delete",
        Some(json!({"ids": [ids[2]]})),
        &[],
    )
    .await;
    assert_eq!((c, j(&v)["deleted"].clone()), (StatusCode::OK, json!(1)));
    let (c, _) = call(
        &st,
        Method::DELETE,
        &format!("/api/v1/inbox/chats/{chat}"),
        None,
        &[],
    )
    .await;
    assert_eq!(c, StatusCode::NO_CONTENT);
    let _ = std::fs::remove_dir_all(d);
}

#[tokio::test]
async fn progress_and_templates() {
    let (st, d) = setup("prog");
    let (_, v) = call(
        &st,
        Method::POST,
        "/api/v1/items",
        Some(json!({"title":"复刻","type":"note"})),
        &[],
    )
    .await;
    let id = j(&v)["id"].as_str().unwrap().to_string();
    for i in 0..3 {
        let (c, v) = call(&st, Method::POST, &format!("/api/v1/items/{id}/progress"), Some(json!({"text": format!("第 {i} 步"), "status": if i == 2 {"done"} else {"working"}, "files": ["src/main.rs"]})), &[("x-actor", "claude-code")]).await;
        assert_eq!(c, StatusCode::CREATED, "{v}");
    }
    let (_, v) = call(&st, Method::GET, &format!("/api/v1/items/{id}"), None, &[]).await;
    let p = &j(&v)["agentProgress"];
    assert_eq!(p.as_array().unwrap().len(), 3);
    assert_eq!(p[2]["status"], "done");
    assert_eq!(p[0]["by"], "claude-code");
    let (c, _) = call(
        &st,
        Method::POST,
        &format!("/api/v1/items/{id}/progress"),
        Some(json!({"text": "x", "status": "maybe"})),
        &[],
    )
    .await;
    assert_eq!(c, StatusCode::BAD_REQUEST);
    let (c, _) = call(
        &st,
        Method::POST,
        "/api/v1/items/nope/progress",
        Some(json!({"text": "x"})),
        &[],
    )
    .await;
    assert_eq!(c, StatusCode::NOT_FOUND);

    let (_, v) = call(&st, Method::GET, "/api/v1/templates", None, &[]).await;
    let t = j(&v)["templates"].clone();
    assert!(t.as_array().unwrap().iter().any(|x| x["id"] == "rebuild"));
    let (c, v) = call(&st, Method::PUT, "/api/v1/templates", Some(json!({"templates": [{"id":"mine","name":"我的","goal":"g","prompt":"p","resume":"r"}]})), &[]).await;
    assert_eq!(c, StatusCode::OK);
    assert_eq!(j(&v)["templates"].as_array().unwrap().len(), 1);
    let (c, _) = call(
        &st,
        Method::PUT,
        "/api/v1/templates",
        Some(json!({"templates": [{"id":"a","name":""}]})),
        &[],
    )
    .await;
    assert_eq!(c, StatusCode::BAD_REQUEST);
    let (_, v) = call(
        &st,
        Method::PUT,
        "/api/v1/templates",
        Some(json!({"templates": []})),
        &[],
    )
    .await;
    assert!(j(&v)["templates"].as_array().unwrap().len() >= 4);
    let _ = std::fs::remove_dir_all(d);
}

#[tokio::test]
async fn qa_on_notes() {
    let (st, d) = setup("qa");
    let (_, v) = call(&st, Method::POST, "/api/v1/items", Some(json!({"title":"AutoSAR","type":"note","body":"AutoSAR 分为应用层、RTE 和基础软件层。基础软件层又分成服务层、ECU 抽象层和微控制器抽象层。"})), &[]).await;
    let id = j(&v)["id"].as_str().unwrap().to_string();
    let (c, v) = call(&st, Method::POST, &format!("/api/v1/items/{id}/qa"), Some(json!({"quote":"RTE","question":"RTE 是干什么的","answer":"运行时环境，负责组件间通信。"})), &[("x-actor","claude-code")]).await;
    assert_eq!(c, StatusCode::CREATED, "{v}");
    let qa = &j(&v)["qa"][0];
    assert_eq!(qa["prefix"], "AutoSAR 分为应用层、");
    assert!(qa["suffix"].as_str().unwrap().starts_with(" 和基础软件层"));
    assert_eq!(qa["turns"][0]["by"], "claude-code");
    let (c, _) = call(
        &st,
        Method::POST,
        &format!("/api/v1/items/{id}/qa"),
        Some(json!({"quote":"不存在的原文","question":"q","answer":"a"})),
        &[],
    )
    .await;
    assert_eq!(c, StatusCode::BAD_REQUEST);
    // 问答内容能搜到
    let (_, v) = call(&st, Method::GET, "/api/v1/items?q=运行时环境", None, &[]).await;
    assert_eq!(j(&v)["total"], 1);
    let _ = std::fs::remove_dir_all(d);
}

#[tokio::test]
async fn next_ui_is_served() {
    let (st, _dir) = setup("next_ui");
    let (s, _) = call(&st, Method::GET, "/next", None, &[]).await;
    assert_eq!(s, StatusCode::PERMANENT_REDIRECT);
    // 构建过就是界面，没构建过给出提示；两种情况下页面地址都走同一个入口
    let (s, home) = call(&st, Method::GET, "/next/", None, &[]).await;
    assert!(
        s == StatusCode::OK || s == StatusCode::SERVICE_UNAVAILABLE,
        "{s}"
    );
    let (s2, deep) = call(&st, Method::GET, "/next/notes/abc", None, &[]).await;
    assert_eq!((s, &home), (s2, &deep));
    if s == StatusCode::OK {
        assert!(home.contains("<div id=\"root\">"));
    }
    let (s, _) = call(&st, Method::GET, "/next/assets/missing.js", None, &[]).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    // 旧界面不受影响
    let (s, _) = call(&st, Method::GET, "/", None, &[]).await;
    assert_eq!(s, StatusCode::OK);
}
