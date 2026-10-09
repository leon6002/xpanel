use super::*;
use crate::inbox::MessageQuery;
use serde_json::json;
use std::collections::HashMap;
use xp_core::{NewItem, PriorityChange};

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("xp-store-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d
}

fn todo(id: &str, title: &str, updated: f64) -> Value {
    json!({"id": id, "type": "todo", "title": title, "body": "", "tags": [], "done": false, "pinned": false, "createdAt": 1, "updatedAt": updated})
}

#[test]
fn imports_v1_json_and_assets_once() {
    let d = tmp("import");
    fs::write(
        d.join("workbench.json"),
        json!({"version":1,"items":[todo("a","旧的待办",1.0), todo("b","第二条",2.0)]}).to_string(),
    )
    .unwrap();
    fs::create_dir_all(d.join("assets")).unwrap();
    fs::write(d.join("assets/pic-1.png"), b"png").unwrap();
    let st = Store::open(&d).unwrap();
    let items = st.all_items().unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(items[0]["title"], "旧的待办");
    assert!(!d.join("workbench.json").exists());
    assert!(d.join("workbench.v1.json").exists());
    assert_eq!(st.get_asset("pic-1.png").unwrap(), b"png");
    let n: i64 = st
        .lock()
        .query_row("SELECT COUNT(*) FROM assets", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 1);
    assert!(d.join("backups").read_dir().unwrap().count() >= 1);
    drop(st);
    // 再放一个 workbench.json 也不会重复导入
    fs::write(
        d.join("workbench.json"),
        json!([todo("c", "新的", 1.0)]).to_string(),
    )
    .unwrap();
    let st = Store::open(&d).unwrap();
    assert_eq!(st.all_items().unwrap().len(), 2);
    let _ = fs::remove_dir_all(d);
}

#[test]
fn v1_ops_keep_old_semantics() {
    let d = tmp("ops");
    let st = Store::open(&d).unwrap();
    let r0 = st.rev().unwrap();
    st.apply_op(
        Op::Upsert {
            item: todo("a", "x", 1.0),
        },
        ACTOR_UI,
    )
    .unwrap();
    st.apply_op(
        Op::Upsert {
            item: todo("a", "y", 2.0),
        },
        ACTOR_UI,
    )
    .unwrap();
    // 导入时旧的不覆盖新的
    st.apply_op(
        Op::Import {
            items: vec![todo("a", "old", 1.0), todo("b", "b", 1.0)],
        },
        ACTOR_UI,
    )
    .unwrap();
    let items = st.all_items().unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(items[0]["title"], "y");
    assert!(st.rev().unwrap() > r0);
    // 软删除：列表里没了，库里还在
    st.apply_op(Op::Delete { id: "b".into() }, ACTOR_UI)
        .unwrap();
    assert_eq!(st.all_items().unwrap().len(), 1);
    assert!(matches!(st.get("b"), Err(StoreError::NotFound(_))));
    // 删除之后，更旧的导入不会让它复活；再次 upsert 会恢复
    st.apply_op(
        Op::Import {
            items: vec![todo("b", "b", 1.0)],
        },
        ACTOR_UI,
    )
    .unwrap();
    assert_eq!(st.all_items().unwrap().len(), 1);
    st.apply_op(
        Op::Upsert {
            item: todo("b", "回来了", 9e15),
        },
        ACTOR_UI,
    )
    .unwrap();
    assert_eq!(st.all_items().unwrap().len(), 2);
    // 不合格的操作是 Invalid（HTTP 400），不是暂时失败
    assert!(matches!(
        st.apply_op(
            Op::Upsert {
                item: json!({"title":"no id"})
            },
            ACTOR_UI
        ),
        Err(StoreError::Invalid(_))
    ));
    // 顺序和写入顺序一致，更新不改变位置
    let ids: Vec<_> = st
        .all_items()
        .unwrap()
        .iter()
        .map(|v| v["id"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(ids, ["a", "b"]);
    let _ = fs::remove_dir_all(d);
}

#[test]
fn search_chinese_and_filters() {
    let d = tmp("search");
    let st = Store::open(&d).unwrap();
    let mk = |t: &str, extra: Value| {
        let mut n: NewItem = serde_json::from_value(json!({"title": t})).unwrap();
        if let Value::Object(o) = extra {
            n = serde_json::from_value(Value::Object(
                o.into_iter()
                    .chain([("title".to_string(), json!(t))])
                    .collect(),
            ))
            .unwrap();
        }
        n.into_item(xp_core::now_ms(), "test").unwrap()
    };
    st.create(
        vec![
            mk(
                "整理客户反馈的问题清单",
                json!({"priority":"P1","tags":["客户"]}),
            ),
            mk("写周报", json!({"type":"todo","body":"本周完成了接口联调"})),
            mk(
                "随手记",
                json!({"type":"note","body":"Rust 的 trigram 分词"}),
            ),
        ],
        "test",
    )
    .unwrap();
    let q = |q: &str| Filter {
        q: Some(q.into()),
        ..Default::default()
    };
    assert_eq!(st.list(&q("客户反馈")).unwrap().1, 1);
    assert_eq!(st.list(&q("周报")).unwrap().1, 1); // 两个字走 LIKE
    assert_eq!(st.list(&q("接口联调")).unwrap().1, 1); // 搜正文
    assert_eq!(st.list(&q("TRIGRAM")).unwrap().1, 1); // 不区分大小写
    assert_eq!(st.list(&q("周报 联调")).unwrap().1, 1); // 多个词取交集
    assert_eq!(st.list(&q("不存在的词")).unwrap().1, 0);
    assert_eq!(st.list(&q("50%")).unwrap().1, 0); // 通配符被转义
    let f = Filter {
        types: Some("todo".into()),
        priority: Some("P1".into()),
        ..Default::default()
    };
    let (v, n) = st.list(&f).unwrap();
    assert_eq!(n, 1);
    assert_eq!(v[0]["tags"], json!(["客户"]));
    // 分页
    let f = Filter {
        limit: Some(1),
        offset: Some(1),
        ..Default::default()
    };
    let (v, n) = st.list(&f).unwrap();
    assert_eq!((v.len(), n), (1, 3));
    assert!(st
        .list(&Filter {
            status: Some("x".into()),
            ..Default::default()
        })
        .is_err());
    let _ = fs::remove_dir_all(d);
}

#[test]
fn api_writes_are_idempotent_and_audited() {
    let d = tmp("api");
    let st = Store::open(&d).unwrap();
    let it = NewItem {
        id: Some("fixed".into()),
        title: "来自 AI".into(),
        ..Default::default()
    }
    .into_item(100.0, "claude")
    .unwrap();
    st.create(vec![it.clone()], "claude").unwrap();
    // 标记完成后，AI 重试同一个 id：不新增、不把完成状态改回去、创建时间不变
    let mut p = Map::new();
    p.insert("done".into(), json!(true));
    let v = st.update("fixed", &p, "claude").unwrap();
    assert!(v["doneAt"].as_f64().is_some());
    let mut again = it.clone();
    again["title"] = json!("来自 AI（重试）");
    again["createdAt"] = json!(999);
    let v = st.create(vec![again], "claude").unwrap();
    assert_eq!(v[0]["done"], true);
    assert_eq!(v[0]["createdAt"], 100.0);
    assert_eq!(v[0]["title"], "来自 AI（重试）");
    assert_eq!(st.all_items().unwrap().len(), 1);
    let log = st.audit(10, Some("fixed")).unwrap();
    assert_eq!(log.len(), 3);
    assert_eq!(log[0]["actor"], "claude");
    assert_eq!(log[2]["action"], "create");
    assert!(log[0]["before"].is_object());
    // 界面的修改只记动作，不存内容
    st.apply_op(
        Op::Upsert {
            item: todo("u", "ui", 1.0),
        },
        ACTOR_UI,
    )
    .unwrap();
    let log = st.audit(1, Some("u")).unwrap();
    assert!(log[0]["after"].is_null());
    assert!(matches!(
        st.update("nope", &p, "x"),
        Err(StoreError::NotFound(_))
    ));
    st.delete("fixed", "claude").unwrap();
    assert!(matches!(
        st.delete("fixed", "claude"),
        Err(StoreError::NotFound(_))
    ));
    let _ = fs::remove_dir_all(d);
}

#[test]
fn reprioritize_dry_run_then_apply() {
    let d = tmp("prio");
    let st = Store::open(&d).unwrap();
    st.apply_op(
        Op::Upsert {
            item: todo("a", "A", 1.0),
        },
        ACTOR_UI,
    )
    .unwrap();
    st.apply_op(
        Op::Upsert {
            item: todo("b", "B", 1.0),
        },
        ACTOR_UI,
    )
    .unwrap();
    let ch: Vec<PriorityChange> = serde_json::from_value(
        json!([{"id":"a","priority":"P0","reason":"客户在催"},{"id":"b","rank":1}]),
    )
    .unwrap();
    let rev = st.rev().unwrap();
    let diff = st.reprioritize(&ch, true, "claude").unwrap();
    assert_eq!(diff.len(), 2);
    assert_eq!(diff[0].to["priority"], "P0");
    assert_eq!(st.rev().unwrap(), rev);
    assert!(st.get("a").unwrap().get("priority").is_none());
    st.reprioritize(&ch, false, "claude").unwrap();
    assert_eq!(st.get("a").unwrap()["priority"], "P0");
    assert_eq!(st.get("b").unwrap()["rank"], 1.0);
    assert_eq!(st.audit(1, Some("a")).unwrap()[0]["note"], "客户在催");
    // 有一条不合法，整批不生效
    let bad: Vec<PriorityChange> =
        serde_json::from_value(json!([{"id":"a","priority":"P3"},{"id":"zz","priority":"P1"}]))
            .unwrap();
    assert!(st.reprioritize(&bad, false, "claude").is_err());
    assert_eq!(st.get("a").unwrap()["priority"], "P0");
    let _ = fs::remove_dir_all(d);
}

#[test]
fn keys_and_events() {
    let d = tmp("keys");
    let st = Store::open(&d).unwrap();
    let k = st.create_key("claude-code").unwrap();
    assert!(k.starts_with("xp_"));
    assert!(st.create_key("claude-code").is_err());
    assert!(st.create_key("ui").is_err());
    assert_eq!(st.verify_key(&k).unwrap().as_deref(), Some("claude-code"));
    assert_eq!(st.verify_key("xp_wrong").unwrap(), None);
    assert!(st.list_keys().unwrap()[0]["lastUsed"].is_number());
    st.delete_key("claude-code").unwrap();
    assert_eq!(st.verify_key(&k).unwrap(), None);
    let mut rx = st.subscribe();
    let rev = st
        .apply_op(
            Op::Upsert {
                item: todo("a", "x", 1.0),
            },
            ACTOR_UI,
        )
        .unwrap();
    assert_eq!(rx.try_recv().unwrap(), rev);
    let _ = fs::remove_dir_all(d);
}

#[test]
fn backups_and_cold_copy() {
    let d = tmp("backup");
    let cold = tmp("cold");
    let st = Store::open(&d).unwrap();
    st.put_asset("a-1.png", b"x").unwrap();
    st.apply_op(
        Op::Upsert {
            item: todo("a", "x", 1.0),
        },
        ACTOR_UI,
    )
    .unwrap();
    st.set_cold_backup_dir(Some(cold.clone()));
    // 设置冷备份位置后马上（在后台）补一份当天的
    st.wait_cold_copy();
    assert_eq!(
        cold.join("xpanel-backup/backups")
            .read_dir()
            .unwrap()
            .count(),
        1
    );
    let p = st.backup_now("2000-01-01").unwrap();
    st.wait_cold_copy();
    assert!(p.exists());
    // 备份是完整可打开的数据库
    let c = Connection::open(&p).unwrap();
    let n: i64 = c
        .query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 1);
    assert!(cold
        .join("xpanel-backup/backups/xpanel-2000-01-01.db")
        .exists());
    assert!(cold.join("xpanel-backup/assets/a-1.png").exists());
    // 冷备份盘不在也不报错
    st.set_cold_backup_dir(Some(d.join("not-mounted")));
    assert!(st.backup_now("2000-01-02").is_ok());
    st.wait_cold_copy();
    assert!(st.put_asset("../x", b"").is_err());
    let _ = fs::remove_dir_all(d);
    let _ = fs::remove_dir_all(cold);
}

#[test]
fn one_click_backup_to_drive() {
    let d = tmp("snap");
    let cold = tmp("snap-cold");
    let st = Store::open(&d).unwrap();
    // 没设置备份位置 / 盘没插：说清楚，不是暂时故障就不报 503
    assert!(matches!(
        st.backup_to_drive(false),
        Err(StoreError::Invalid(_))
    ));
    st.set_cold_backup_dir(Some(std::env::temp_dir().join(format!(
        "xp-store-not-mounted-{}/xpanel",
        std::process::id()
    ))));
    assert!(matches!(
        st.backup_to_drive(false),
        Err(StoreError::Unavailable(_))
    ));
    assert_eq!(st.backup_status().unwrap()["available"], false);

    st.set_cold_backup_dir(Some(cold.clone()));
    st.wait_cold_copy();
    st.put_asset("a-1.png", b"one").unwrap();
    st.put_asset("b-2.pdf", b"two").unwrap();
    for id in ["a", "b"] {
        st.apply_op(
            Op::Upsert {
                item: todo(id, "x", 1.0),
            },
            ACTOR_UI,
        )
        .unwrap();
    }
    let root = cold.join("xpanel-backup");
    // 模拟上次复制到一半：半截附件和残留的 .part
    fs::create_dir_all(root.join("assets")).unwrap();
    fs::write(root.join("assets/b-2.pdf"), b"t").unwrap();
    fs::write(root.join("assets/.b-2.pdf.part"), b"t").unwrap();

    let r = st.backup_to_drive(false).unwrap();
    assert_eq!(r["manifest"]["items"], 2);
    assert_eq!(r["manifest"]["assets"], 2);
    assert_eq!(fs::read(root.join("assets/b-2.pdf")).unwrap(), b"two");
    assert!(!root.join("assets/.b-2.pdf.part").exists());
    let snap = root.join(r["manifest"]["file"].as_str().unwrap());
    let n: i64 = Connection::open(&snap)
        .unwrap()
        .query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 2);
    let s = st.backup_status().unwrap();
    assert_eq!(s["available"], true);
    assert_eq!(s["running"], false);
    assert_eq!(s["last"]["file"], r["manifest"]["file"]);

    // 再备份一次：附件都在了，不再复制
    let r2 = st.backup_to_drive(false).unwrap();
    assert_eq!(r2["copiedFiles"], 0);
    let _ = fs::remove_dir_all(d);
    let _ = fs::remove_dir_all(cold);
}

/// 两台电脑通过外置硬盘来回交接：笔记本备份 → 台式机合并、修改、备份 → 笔记本合并
#[test]
fn merge_between_two_computers() {
    let (da, db, cold) = (tmp("merge-a"), tmp("merge-b"), tmp("merge-cold"));
    let a = Store::open(&da).unwrap();
    let b = Store::open(&db).unwrap();
    a.set_replica_name("笔记本").unwrap();
    b.set_replica_name("台式机").unwrap();
    // 两个数据文件夹在测试里同时开着，自动复制错开，免得同时写同一个文件
    a.set_cold_backup_dir(Some(cold.clone()));
    a.wait_cold_copy();
    b.set_cold_backup_dir(Some(cold.clone()));
    b.wait_cold_copy();
    let up = |st: &Store, item: Value| st.apply_op(Op::Upsert { item }, ACTOR_UI).unwrap();

    // 笔记本：三条 + 一个附件，备份
    for id in ["a1", "a2", "a3"] {
        up(&a, todo(id, id, 10.0));
    }
    a.put_asset("pic-1.png", b"png").unwrap();
    // 两边各自导入过同一个群（消息有重叠）
    a.wechat_import(
        &wechat_zip(WX1, &[("微信图片_1.jpg", b"JPEG1")]),
        "a.zip",
        "测试群",
        "ui",
    )
    .unwrap();
    b.wechat_import(
        &wechat_zip(WX2, &[("微信图片_9.jpg", b"JPEG1")]),
        "b.zip",
        "测试群",
        "ui",
    )
    .unwrap();
    assert_eq!(a.backup_status().unwrap()["needsMerge"], false);
    a.backup_to_drive(false).unwrap();

    // 台式机：外置硬盘上有笔记本的备份，还没合并就备份会被拦下
    assert_eq!(b.backup_status().unwrap()["needsMerge"], true);
    assert_eq!(b.backup_to_drive(false).unwrap()["needsMerge"], true);
    let p = b.merge_preview().unwrap();
    assert_eq!(p["first"], true);
    assert_eq!(p["counts"]["add"], 3);
    assert_eq!(p["assets"]["missing"], 1);
    assert_eq!(p["changes"][0]["originName"], "笔记本");
    let file = p["latest"]["file"].as_str().unwrap().to_string();
    let all: HashMap<String, String> = p["changes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| (c["id"].as_str().unwrap().to_string(), "remote".to_string()))
        .collect();
    // 预览之后外置硬盘上的备份变了：不合并
    assert!(matches!(
        b.merge_apply("snapshots/xpanel-old.db", &all),
        Err(StoreError::Invalid(_))
    ));
    let r = b.merge_apply(&file, &all).unwrap();
    assert_eq!(r["applied"]["add"], 3);
    assert_eq!(b.all_items().unwrap().len(), 3);
    assert!(db.join("assets/pic-1.png").exists());
    // 同一个群合成一个，重复的消息不会多出来（WX1 4 条 + WX2 里新的 1 条），也都能搜到
    assert_eq!(b.list_chats().unwrap().len(), 1);
    let count = |sql: &str| -> i64 { b.lock().query_row(sql, [], |r| r.get(0)).unwrap() };
    assert_eq!(
        count("SELECT COUNT(*) FROM messages WHERE deleted_at IS NULL"),
        5
    );
    assert_eq!(count("SELECT COUNT(*) FROM messages_fts"), 5);
    assert_eq!(count("SELECT COUNT(*) FROM bundles"), 2);
    assert_eq!(b.backup_status().unwrap()["needsMerge"], false);
    // 已经对齐了，再预览没有改动
    assert_eq!(b.merge_preview().unwrap()["changes"], json!([]));

    // 台式机：改 a1、删 a3、新建 b1，备份
    up(&b, todo("a1", "台式机改的", 20.0));
    b.delete("a3", ACTOR_UI).unwrap();
    up(&b, todo("b1", "台式机新建", 20.0));
    assert!(b.backup_to_drive(false).unwrap()["manifest"].is_object());

    // 笔记本：同时也改了 a1（冲突）和 a2（只有这边改了）
    up(&a, todo("a1", "笔记本改的", 30.0));
    up(&a, todo("a2", "笔记本改 a2", 30.0));
    assert_eq!(a.backup_status().unwrap()["needsMerge"], true);
    let p = a.merge_preview().unwrap();
    assert_eq!(p["first"], false);
    let kinds: HashMap<String, String> = p["changes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            (
                c["id"].as_str().unwrap().to_string(),
                c["kind"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    assert_eq!(kinds.len(), 3, "{kinds:?}"); // a2 只有本机改了，不算
    assert_eq!(kinds["a1"], "conflict");
    assert_eq!(kinds["a3"], "delete");
    assert_eq!(kinds["b1"], "add");
    let c1 = p["changes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == "a1")
        .unwrap();
    assert_eq!(c1["choice"], "local"); // 笔记本这边较新
    assert_eq!(c1["originName"], "台式机");
    let choices: HashMap<String, String> = [("a1", "both"), ("a3", "remote"), ("b1", "remote")]
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    let file = p["latest"]["file"].as_str().unwrap().to_string();
    let r = a.merge_apply(&file, &choices).unwrap();
    assert_eq!(r["applied"]["both"], 1);
    let titles: Vec<String> = a
        .all_items()
        .unwrap()
        .iter()
        .map(|i| i["title"].as_str().unwrap().to_string())
        .collect();
    assert!(titles.contains(&"笔记本改的".to_string()), "{titles:?}");
    assert!(titles.contains(&"台式机改的（台式机的版本）".to_string()));
    assert!(titles.contains(&"笔记本改 a2".to_string()));
    assert!(titles.contains(&"台式机新建".to_string()));
    assert!(a.get("a3").is_err());
    // 合并前留了本机备份；合并后可以直接备份
    assert!(fs::read_dir(da.join("backups"))
        .unwrap()
        .flatten()
        .any(|e| e.file_name().to_string_lossy().starts_with("premerge-")));
    assert_eq!(a.backup_status().unwrap()["needsMerge"], false);
    assert!(a.backup_to_drive(false).unwrap()["manifest"].is_object());
    // 台式机再合并：只拿到笔记本这次的改动
    let p = b.merge_preview().unwrap();
    let ids: Vec<&str> = p["changes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids.len(), 3, "{ids:?}"); // a1（笔记本的版本）、a2、复制出来的那条
    assert!(p["changes"]
        .as_array()
        .unwrap()
        .iter()
        .all(|c| c["kind"] != "conflict" && c["originName"] == "笔记本"));
    drop((a, b));
    for d in [da, db, cold] {
        let _ = fs::remove_dir_all(d);
    }
}

#[test]
fn unwritable_dir_is_unavailable() {
    let d = tmp("bad");
    let f = d.join("file");
    fs::write(&f, "x").unwrap();
    assert!(matches!(Store::open(&f), Err(StoreError::Unavailable(_))));
    assert!(matches!(Store::open(""), Err(StoreError::Invalid(_))));
    let _ = fs::remove_dir_all(d);
}

#[test]
fn devices_seeded_from_v1_items_and_renamed_everywhere() {
    let d = tmp("dev-seed");
    let mut a = todo("a", "在笔记本上做", 1.0);
    a["device"] = json!("笔记本");
    let mut b = todo("b", "在 Mac 上做", 1.0);
    b["device"] = json!("Mac");
    fs::write(
        d.join("workbench.json"),
        json!([a, b, todo("c", "不限设备", 1.0)]).to_string(),
    )
    .unwrap();
    let st = Store::open(&d).unwrap();
    let devs = st.list_devices().unwrap();
    let names: Vec<_> = devs.iter().map(|v| v["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["Mac", "笔记本"]);
    assert_eq!(devs[0]["kind"], "mac");
    assert_eq!(devs[1]["kind"], "laptop");
    // 状态里带上设备
    assert_eq!(
        st.legacy_state().unwrap()["devices"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    // 改名：条目里的名字跟着改，updatedAt 不变
    let id = devs[1]["id"].as_str().unwrap().to_string();
    let p: Map<String, Value> = serde_json::from_value(json!({"name":"WORK-PC","description":"主力工作机","networks":[{"name":"家里","ip":"192.168.1.37"}]})).unwrap();
    st.update_device(&id, &p, "ui").unwrap();
    let it = st.get("a").unwrap();
    assert_eq!(it["device"], "WORK-PC");
    assert_eq!(it["updatedAt"], 1.0);
    assert_eq!(
        st.list(&Filter {
            device: Some("WORK-PC".into()),
            ..Default::default()
        })
        .unwrap()
        .1,
        1
    );
    // 重名不行
    let p: Map<String, Value> = serde_json::from_value(json!({"name":"Mac"})).unwrap();
    assert!(matches!(
        st.update_device(&id, &p, "ui"),
        Err(StoreError::Invalid(_))
    ));
    let p: Map<String, Value> = serde_json::from_value(json!({"name":"Mac"})).unwrap();
    assert!(st.create_device(&p, "ui").is_err());
    drop(st);
    // 再次打开不会重复建
    let st = Store::open(&d).unwrap();
    assert_eq!(st.list_devices().unwrap().len(), 2);
    let _ = fs::remove_dir_all(d);
}

#[test]
fn heartbeat_registers_and_only_bumps_rev_on_change() {
    use xp_core::device::Heartbeat;
    let d = tmp("dev-hb");
    let st = Store::open(&d).unwrap();
    let hb = Heartbeat {
        id: "dev-1".into(),
        hostname: "BASE".into(),
        os: "windows".into(),
        ips: vec![json!({"ip":"192.168.1.20","iface":"以太网"})],
        agent_version: "0.2.0".into(),
        ai_tools: vec!["claude".into()],
        is_host: true,
    };
    let r0 = st.rev().unwrap();
    let v = st.heartbeat(&hb).unwrap();
    assert_eq!(v["name"], "BASE");
    assert_eq!(v["isHost"], true);
    let r1 = st.rev().unwrap();
    assert!(r1 > r0);
    // 一分钟后同样的心跳：不打扰界面
    st.heartbeat(&hb).unwrap();
    assert_eq!(st.rev().unwrap(), r1);
    assert!(
        st.get_device("dev-1").unwrap()["lastSeen"]
            .as_f64()
            .unwrap()
            > 0.0
    );
    // IP 变了：通知界面
    let mut hb2 = hb.clone();
    hb2.ips = vec![json!({"ip":"192.168.1.21","iface":"以太网"})];
    st.heartbeat(&hb2).unwrap();
    assert!(st.rev().unwrap() > r1);
    // 另一台机器也叫 BASE：自动加后缀
    let hb3 = Heartbeat {
        id: "dev-2".into(),
        hostname: "BASE".into(),
        ..Default::default()
    };
    assert_eq!(st.heartbeat(&hb3).unwrap()["name"], "BASE-2");
    // 删掉后还在心跳：恢复
    st.delete_device("dev-2", "ui").unwrap();
    assert_eq!(st.list_devices().unwrap().len(), 1);
    st.heartbeat(&hb3).unwrap();
    assert_eq!(st.list_devices().unwrap().len(), 2);
    assert!(st.heartbeat(&Heartbeat::default()).is_err());
    let _ = fs::remove_dir_all(d);
}

#[test]
fn upgrade_from_schema_v1_backs_up_first() {
    let d = tmp("dev-upgrade");
    {
        // 造一个只有 v1 结构的库
        let c = Connection::open(d.join(DB_FILE)).unwrap();
        c.execute_batch(
            "CREATE TABLE items (id TEXT PRIMARY KEY, type TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', done INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0, priority TEXT, device TEXT NOT NULL DEFAULT '', created_at REAL NOT NULL DEFAULT 0, updated_at REAL NOT NULL DEFAULT 0, deleted_at REAL, data TEXT NOT NULL);
             CREATE VIRTUAL TABLE items_fts USING fts5(id UNINDEXED, title, body, tokenize = 'trigram');
             CREATE TABLE assets (name TEXT PRIMARY KEY, mime TEXT NOT NULL, size INTEGER NOT NULL, created_at REAL NOT NULL);
             CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at REAL NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, item_id TEXT, note TEXT, before TEXT, after TEXT);
             CREATE TABLE api_keys (name TEXT PRIMARY KEY, key_hash TEXT NOT NULL UNIQUE, created_at REAL NOT NULL, last_used REAL);
             CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             INSERT INTO meta VALUES ('rev','1'), ('v1_imported','1');
             INSERT INTO items (id, type, title, device, data) VALUES ('a','todo','t','台式机','{\"id\":\"a\",\"type\":\"todo\",\"title\":\"t\",\"device\":\"台式机\"}');
             PRAGMA user_version = 1;",
        )
        .unwrap();
    }
    let st = Store::open(&d).unwrap();
    assert_eq!(st.list_devices().unwrap()[0]["name"], "台式机");
    let backups: Vec<_> = fs::read_dir(d.join("backups"))
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    assert!(
        backups.iter().any(|n| n.starts_with("premigrate-v1-")),
        "{backups:?}"
    );
    let _ = fs::remove_dir_all(d);
}

#[test]
fn categories_and_tags() {
    let d = tmp("cats");
    let st = Store::open(&d).unwrap();
    let mk = |id: &str, cat: &str, tags: &[&str], done: bool| {
        let mut it = todo(id, id, 1.0);
        if !cat.is_empty() {
            it["category"] = json!(cat);
        }
        it["tags"] = json!(tags);
        it["done"] = json!(done);
        st.apply_op(Op::Upsert { item: it }, ACTOR_UI).unwrap();
    };
    mk("a", "工作/AutoSAR", &["can", "紧急"], false);
    mk("b", "工作/AutoSAR/配置", &["can"], true);
    mk("c", "工作", &["周报"], false);
    mk("d", "", &["can"], false);
    st.create_category("学习/Rust", "ui").unwrap();
    assert!(st.create_category("学习/Rust", "ui").is_err());
    let cats = st.list_categories().unwrap();
    let get = |p: &str| cats.iter().find(|c| c["path"] == p).cloned().unwrap();
    assert_eq!(get("工作")["total"], 3);
    assert_eq!(get("工作")["open"], 2);
    assert_eq!(get("工作/AutoSAR")["total"], 2);
    assert_eq!(get("工作/AutoSAR")["direct"], 1);
    assert_eq!(get("学习")["total"], 0); // 空分类的上级也列出来
    assert_eq!(get("学习/Rust")["explicit"], true);
    assert_eq!(
        st.legacy_state().unwrap()["categories"],
        json!(["学习/Rust"])
    );
    // 按分类筛选（包括子分类）；none = 未分类
    assert_eq!(
        st.list(&Filter {
            category: Some("工作/AutoSAR".into()),
            ..Default::default()
        })
        .unwrap()
        .1,
        2
    );
    assert_eq!(
        st.list(&Filter {
            category: Some("none".into()),
            ..Default::default()
        })
        .unwrap()
        .1,
        1
    );
    // 移动：工作/AutoSAR → 项目/AUTOSAR，子分类跟着走
    assert_eq!(
        st.rename_category("工作/AutoSAR", "项目/AUTOSAR", "ui")
            .unwrap(),
        2
    );
    assert_eq!(st.get("b").unwrap()["category"], "项目/AUTOSAR/配置");
    assert_eq!(st.get("a").unwrap()["updatedAt"], 1.0);
    assert!(st.rename_category("项目", "项目/子", "ui").is_err());
    assert!(matches!(
        st.rename_category("没有", "x", "ui"),
        Err(StoreError::NotFound(_))
    ));
    // 空分类也能改名
    st.rename_category("学习", "读书", "ui").unwrap();
    assert_eq!(st.category_paths().unwrap(), ["读书/Rust"]);
    // 删除：条目移到上一级 / 变成未分类
    assert_eq!(
        st.delete_category("项目/AUTOSAR/配置", true, "ui").unwrap(),
        1
    );
    assert_eq!(st.get("b").unwrap()["category"], "项目/AUTOSAR");
    st.delete_category("项目", false, "ui").unwrap();
    assert!(st.get("a").unwrap().get("category").is_none());
    // 标签：列表、合并、删除
    let tags = st.list_tags().unwrap();
    assert_eq!(tags[0]["tag"], "can");
    assert_eq!(tags[0]["total"], 3);
    assert_eq!(st.rename_tag("紧急", "can", "ui").unwrap(), 1); // 合并
    assert_eq!(st.get("a").unwrap()["tags"], json!(["can"]));
    st.rename_tag("can", "CAN总线", "ui").unwrap();
    assert_eq!(st.get("d").unwrap()["tags"], json!(["CAN总线"]));
    assert!(st.rename_tag("周报", "两个 词", "ui").is_err());
    assert_eq!(st.delete_tag("CAN总线", "ui").unwrap(), 3);
    assert_eq!(st.list_tags().unwrap().len(), 1);
    let _ = fs::remove_dir_all(d);
}

// ---------------------------------------------------------------- 收件箱：微信导出

pub(crate) fn wechat_zip(txt: &str, files: &[(&str, &[u8])]) -> Vec<u8> {
    use std::io::Write;
    let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let o = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    w.start_file("聊天记录.txt", o).unwrap();
    w.write_all(txt.as_bytes()).unwrap();
    for (n, b) in files {
        w.start_file(format!("聊天记录内的图片、视频和文件/{n}"), o)
            .unwrap();
        w.write_all(b).unwrap();
    }
    w.finish().unwrap().into_inner()
}

const WX1: &str = "·甲\n2026年9月8日 09:10\n早\n\n·乙\n2026年9月8日 09:11\n[图片] 微信图片_1.jpg\n\n·甲\n2026年9月8日 09:12\n好\n\n·甲\n2026年9月8日 09:12\n好\n";
// 第二次导出：时间有重叠，同一张图文件名变了，多了一条新消息
const WX2: &str = "·乙\n2026年9月8日 09:11\n[图片] 微信图片_9.jpg\n\n·甲\n2026年9月8日 09:12\n好\n\n·甲\n2026年9月8日 09:12\n好\n\n·乙\n2026年9月9日 10:00\n新消息\n[文件] 报告.pdf\n";

#[test]
fn wechat_import_dedups_and_merges() {
    let st = Store::open(tmp("wx")).unwrap();
    let z1 = wechat_zip(WX1, &[("微信图片_1.jpg", b"JPEG1"), ("多余.txt", b"x")]);
    let p = st.wechat_preview(&z1).unwrap();
    assert_eq!(p["count"], 4);
    assert_eq!(p["start"], "2026-09-08 09:10");
    assert_eq!(p["suggestedChat"], "甲、乙");
    assert!(p["matchedChat"].is_null());

    let r = st.wechat_import(&z1, "a.zip", "测试群", "ui").unwrap();
    assert_eq!(r["added"], 4);
    let chat = r["chat"]["id"].as_str().unwrap().to_string();
    assert_eq!(
        r["bundle"]["files"][0]["name"],
        "聊天记录内的图片、视频和文件/多余.txt"
    );

    let z2 = wechat_zip(WX2, &[("微信图片_9.jpg", b"JPEG1")]);
    let p = st.wechat_preview(&z2).unwrap();
    assert_eq!(p["matchedChat"]["name"], "测试群");
    assert_eq!(p["matchedChat"]["duplicates"], 3);
    assert_eq!(p["suggestedChat"], "测试群");
    assert_eq!(p["missing"], 1);
    let r = st.wechat_import(&z2, "b.zip", "测试群", "ui").unwrap();
    assert_eq!(r["added"], 1);
    assert_eq!(r["duplicates"], 3);

    let q = MessageQuery {
        chat: Some(chat.clone()),
        ..Default::default()
    };
    let (msgs, total) = st.list_messages(&q).unwrap();
    assert_eq!(total, 5);
    assert_eq!(msgs[0]["text"], "早");
    assert_eq!(msgs[4]["text"], "新消息\n[文件] 报告.pdf");
    assert_eq!(msgs[4]["attachments"][0]["missing"], true);
    let img = msgs[1]["attachments"][0]["asset"].as_str().unwrap();
    assert!(img.starts_with("wx-") && img.ends_with(".jpg"));
    assert_eq!(st.get_asset(img).unwrap(), b"JPEG1");

    // 分页：从最新往前
    let (page, _) = st
        .list_messages(&MessageQuery {
            chat: Some(chat.clone()),
            limit: Some(2),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(page.len(), 2);
    assert_eq!(page[1]["text"], "新消息\n[文件] 报告.pdf");

    // 已处理到 → 未读数
    let mut patch = Map::new();
    patch.insert("readUpTo".into(), json!("2026-09-08 09:12"));
    st.update_chat(&chat, &patch, "ui").unwrap();
    let chats = st.list_chats().unwrap();
    assert_eq!(chats[0]["count"], 5);
    assert_eq!(chats[0]["unread"], 1);
    assert_eq!(chats[0]["last"]["sender"], "乙");

    // 搜索
    let (hits, _) = st
        .list_messages(&MessageQuery {
            q: Some("新消息".into()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(hits.len(), 1);
    let (hits, _) = st
        .list_messages(&MessageQuery {
            q: Some("早".into()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(hits.len(), 1);

    // Markdown
    let (md, _) = st
        .messages_markdown(&MessageQuery {
            chat: Some(chat.clone()),
            ..Default::default()
        })
        .unwrap();
    assert!(md.starts_with("# 测试群"));
    assert!(md.contains(&format!("![微信图片_1.jpg](asset:{img})")));

    // 删除的消息再导入不会复活
    let first = msgs[0]["id"].as_str().unwrap().to_string();
    assert_eq!(st.delete_messages(&[first], "ui").unwrap(), 1);
    let r = st.wechat_import(&z1, "a.zip", "测试群", "ui").unwrap();
    assert_eq!(r["added"], 0);

    // 导错了聊天名：改名成已有的名字就合并，重复的丢掉
    let r = st.wechat_import(&z2, "b.zip", "导错的", "ui").unwrap();
    assert_eq!(r["added"], 4);
    let wrong = r["chat"]["id"].as_str().unwrap().to_string();
    let mut patch = Map::new();
    patch.insert("name".into(), json!("测试群"));
    let merged = st.update_chat(&wrong, &patch, "ui").unwrap();
    assert_eq!(merged["id"], chat.as_str());
    assert_eq!(st.list_chats().unwrap().len(), 1);
    let (_, total) = st.list_messages(&q).unwrap();
    assert_eq!(total, 4);
    assert_eq!(st.list_bundles(&chat).unwrap().len(), 4);

    st.delete_chat(&chat, "ui").unwrap();
    assert!(st.list_chats().unwrap().is_empty());
}

#[test]
fn wechat_rejects_other_files() {
    let st = Store::open(tmp("wxbad")).unwrap();
    assert!(matches!(
        st.wechat_preview(b"not a zip"),
        Err(StoreError::Invalid(_))
    ));
    let z = wechat_zip("随便写的\n内容", &[]);
    assert!(matches!(st.wechat_preview(&z), Err(StoreError::Invalid(_))));
    let z = wechat_zip(WX1, &[]);
    assert!(matches!(
        st.wechat_import(&z, "a.zip", "  ", "ui"),
        Err(StoreError::Invalid(_))
    ));
    assert_eq!(
        st.set_inbox_me(vec!["甲".into(), " ".into()]).unwrap(),
        vec!["甲"]
    );
    assert_eq!(st.wechat_preview(&z).unwrap()["suggestedChat"], "乙");
}

#[test]
fn deleting_a_parent_moves_children_up() {
    let d = tmp("tree");
    let st = Store::open(&d).unwrap();
    let note = |id: &str, parent: Option<&str>| {
        let mut v = json!({"id": id, "type": "note", "title": id, "body": "", "createdAt": 1, "updatedAt": 1});
        if let Some(p) = parent {
            v["parentId"] = json!(p);
        }
        v
    };
    st.apply_op(
        Op::Import {
            items: vec![
                note("a", None),
                note("b", Some("a")),
                note("c", Some("b")),
                note("d", Some("b")),
            ],
        },
        "t",
    )
    .unwrap();
    st.delete("b", "t").unwrap();
    assert_eq!(st.get("c").unwrap()["parentId"], "a");
    assert_eq!(st.get("d").unwrap()["parentId"], "a");
    st.delete("a", "t").unwrap();
    assert!(st.get("c").unwrap().get("parentId").is_none());
    let _ = fs::remove_dir_all(d);
}

#[test]
fn patch_merges_fields_and_detects_conflicts() {
    let d = tmp("patch");
    let st = Store::open(&d).unwrap();
    st.apply_op(Op::Import { items: vec![json!({"id": "n", "type": "note", "title": "t", "body": "A 写的", "tags": ["x"], "createdAt": 1, "updatedAt": 1})] }, "t").unwrap();
    let m = |v: Value| v.as_object().unwrap().clone();
    // 只改标签：正文不动
    st.apply_op(
        Op::Patch {
            id: "n".into(),
            set: m(json!({"tags": ["y"]})),
            unset: vec![],
            expect: None,
        },
        "t",
    )
    .unwrap();
    let it = st.get("n").unwrap();
    assert_eq!(it["body"], "A 写的");
    assert_eq!(it["tags"], json!(["y"]));
    // 基于旧正文改：冲突，不覆盖
    let e = st
        .apply_op(
            Op::Patch {
                id: "n".into(),
                set: m(json!({"body": ""})),
                unset: vec![],
                expect: Some(m(json!({"body": "旧的"}))),
            },
            "t",
        )
        .unwrap_err();
    assert!(matches!(e, StoreError::Conflict(_)));
    assert_eq!(st.get("n").unwrap()["body"], "A 写的");
    // 基于最新正文改：可以
    st.apply_op(
        Op::Patch {
            id: "n".into(),
            set: m(json!({"body": "B 接着写"})),
            unset: vec!["tags".into()],
            expect: Some(m(json!({"body": "A 写的"}))),
        },
        "t",
    )
    .unwrap();
    let it = st.get("n").unwrap();
    assert_eq!(it["body"], "B 接着写");
    assert!(it.get("tags").is_none());
    let _ = fs::remove_dir_all(d);
}

/// 同步点不是两边共同的起点时不能用：一边没合并就备份了，或者本机的同步点文件对不上。
/// 这时本机改过、删过的条目不能被当成「对方改回去了」悄悄盖掉，要当冲突让人选
#[test]
fn stale_sync_point_is_not_trusted() {
    let (da, db, drive) = (tmp("stale-a"), tmp("stale-b"), tmp("stale-drive"));
    let a = Store::open(&da).unwrap();
    let b = Store::open(&db).unwrap();
    a.set_replica_name("台式机").unwrap();
    b.set_replica_name("笔记本").unwrap();
    a.set_drive_dir(Some(drive.clone()));
    b.set_drive_dir(Some(drive.clone()));
    let up = |st: &Store, item: Value| st.apply_op(Op::Upsert { item }, ACTOR_UI).unwrap();
    let take_all = |st: &Store| {
        let p = st.merge_preview().unwrap();
        let file = p["latest"]["file"].as_str().unwrap().to_string();
        let all: HashMap<String, String> = p["changes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| (c["id"].as_str().unwrap().to_string(), "remote".to_string()))
            .collect();
        st.merge_apply(&file, &all).unwrap();
    };
    let change = |p: &Value, id: &str| -> Value {
        p["changes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["id"] == id)
            .cloned()
            .unwrap_or(Value::Null)
    };

    for id in ["x1", "x2", "x3"] {
        up(&a, todo(id, "原来的", 10.0));
    }
    a.backup_to_drive(false).unwrap();
    // 笔记本合并，改一条、删一条，备份
    take_all(&b);
    up(&b, todo("x1", "笔记本改的", 20.0));
    b.apply_op(Op::Delete { id: "x2".into() }, ACTOR_UI)
        .unwrap();
    b.backup_to_drive(false).unwrap();
    // 台式机没合并笔记本的备份，改了一条就强行备份
    up(&a, todo("x3", "台式机改的", 30.0));
    assert_eq!(a.backup_to_drive(false).unwrap()["needsMerge"], true);
    assert!(a.backup_to_drive(true).unwrap()["manifest"].is_object());

    // 笔记本再合并：台式机那份备份不包含笔记本的同步点，三条都要当冲突，默认各用较新的
    let p = b.merge_preview().unwrap();
    assert_eq!(p["first"], true);
    assert_eq!(change(&p, "x1")["kind"], "conflict");
    assert_eq!(change(&p, "x1")["choice"], "local");
    assert_eq!(change(&p, "x2")["kind"], "conflict");
    assert_eq!(change(&p, "x2")["choice"], "local");
    assert_eq!(change(&p, "x3")["kind"], "conflict");
    assert_eq!(change(&p, "x3")["choice"], "remote");
    let file = p["latest"]["file"].as_str().unwrap().to_string();
    let pick = HashMap::from([("x3".to_string(), "remote".to_string())]);
    b.merge_apply(&file, &pick).unwrap();
    assert_eq!(b.get("x1").unwrap()["title"], "笔记本改的");
    assert!(b.get("x2").is_err());
    assert_eq!(b.get("x3").unwrap()["title"], "台式机改的");

    // 之后正常来回：笔记本备份，台式机的同步点在这份备份的来历里，可以正常三方对比
    b.backup_to_drive(false).unwrap();
    let p = a.merge_preview().unwrap();
    assert_eq!(p["first"], false);
    assert_eq!(change(&p, "x1")["kind"], "update");
    assert_eq!(change(&p, "x2")["kind"], "delete");
    assert!(change(&p, "x3").is_null());
    // 本机的同步点文件和记录对不上（比如恢复过旧数据库）：不用它
    fs::write(da.join("sync/base.json"), r#"{"file":"snapshots/别的.db"}"#).unwrap();
    let p = a.merge_preview().unwrap();
    assert_eq!(p["first"], true);
    assert_eq!(change(&p, "x1")["kind"], "conflict");

    // 外置硬盘上的文件夹不能放在数据文件夹里面
    a.set_drive_dir(Some(da.join("inside")));
    assert!(matches!(
        a.backup_to_drive(false),
        Err(StoreError::Invalid(_))
    ));
    for d in [da, db, drive] {
        let _ = fs::remove_dir_all(d);
    }
}

/// 外置硬盘文件夹和冷备份位置分开设置：一键备份写到外置硬盘那边，每天自动的还是去冷备份
#[test]
fn drive_dir_is_separate_from_cold_backup() {
    let (d, cold, drive) = (tmp("drive-data"), tmp("drive-cold"), tmp("drive-ext"));
    let st = Store::open(&d).unwrap();
    st.set_cold_backup_dir(Some(cold.clone()));
    st.wait_cold_copy();
    st.set_drive_dir(Some(drive.clone()));
    st.apply_op(
        Op::Upsert {
            item: todo("a", "x", 1.0),
        },
        ACTOR_UI,
    )
    .unwrap();
    let r = st.backup_to_drive(false).unwrap();
    assert_eq!(r["manifest"]["items"], 1);
    assert!(drive.join("xpanel-backup/latest.json").exists());
    assert!(!cold.join("xpanel-backup/latest.json").exists());
    assert!(cold.join("xpanel-backup/backups").is_dir());
    assert_eq!(
        st.backup_status().unwrap()["dir"],
        drive.display().to_string()
    );
    // 没单独设置时用冷备份位置
    st.set_drive_dir(None);
    assert_eq!(
        st.backup_status().unwrap()["dir"],
        cold.display().to_string()
    );
    // 填成本机的数据文件夹：说清楚
    st.set_drive_dir(Some(d.clone()));
    assert!(matches!(
        st.backup_to_drive(false),
        Err(StoreError::Invalid(_))
    ));
    for x in [d, cold, drive] {
        let _ = fs::remove_dir_all(x);
    }
}

fn vault_key(st: &Store, kid: &str) {
    st.vault_put_key(
        kid,
        &json!({"kdf": {"alg": "scrypt", "N": 16, "r": 8, "p": 1}, "salt": "c2FsdA", "n": "bm9uY2U", "c": "d3JhcHBlZA"}),
        None,
        ACTOR_UI,
    )
    .unwrap();
}

fn secret(kid: &str, title: &str, c: &str, expect: Option<f64>) -> Value {
    let mut v = json!({"kid": kid, "title": title, "kind": "login", "n": "bm9uY2U", "c": c});
    if let Some(e) = expect {
        v["expect"] = json!(e);
    }
    v
}

/// 密码库只存密文：设主密码、增删改（别处刚改过就拒绝）、AI 的取用请求要等用户确认
#[test]
fn vault_stores_ciphertext_and_gates_requests() {
    let d = tmp("vault");
    let st = Store::open(&d).unwrap();
    assert_eq!(st.vault_state().unwrap()["keys"], json!([]));
    // 还没设主密码不能存条目
    assert!(matches!(
        st.vault_put_secret("sec1", &secret("k1abcd", "GitHub", "AAAA", None), ACTOR_UI),
        Err(StoreError::Invalid(_))
    ));
    vault_key(&st, "k1abcd");
    // 已经设过主密码，不能再新建一把；改主密码要带对 expect
    assert!(matches!(
        st.vault_put_key(
            "k2abcd",
            &json!({"kdf": {}, "salt": "a", "n": "b", "c": "c"}),
            None,
            ACTOR_UI
        ),
        Err(StoreError::Conflict(_))
    ));
    let at = st.vault_state().unwrap()["keys"][0]["updatedAt"]
        .as_f64()
        .unwrap();
    assert!(matches!(
        st.vault_put_key(
            "k1abcd",
            &json!({"kdf": {}, "salt": "a", "n": "b", "c": "c"}),
            Some(at - 1.0),
            ACTOR_UI
        ),
        Err(StoreError::Conflict(_))
    ));
    let s = st
        .vault_put_key(
            "k1abcd",
            &json!({"kdf": {}, "salt": "a", "n": "b", "c": "新的"}),
            Some(at),
            ACTOR_UI,
        )
        .unwrap();
    assert_eq!(s["keys"][0]["c"], "新的");

    let a = st
        .vault_put_secret("sec1", &secret("k1abcd", "GitHub", "AAAA", None), ACTOR_UI)
        .unwrap();
    assert_eq!(a["c"], "AAAA");
    let t = a["updatedAt"].as_f64().unwrap();
    // 同一个 id 再新建、或者基于旧内容改：冲突
    assert!(matches!(
        st.vault_put_secret("sec1", &secret("k1abcd", "GitHub", "BBBB", None), ACTOR_UI),
        Err(StoreError::Conflict(_))
    ));
    assert!(matches!(
        st.vault_put_secret(
            "sec1",
            &secret("k1abcd", "GitHub", "BBBB", Some(t - 1.0)),
            ACTOR_UI
        ),
        Err(StoreError::Conflict(_))
    ));
    let b = st
        .vault_put_secret(
            "sec1",
            &secret("k1abcd", "GitHub 改名", "BBBB", Some(t)),
            ACTOR_UI,
        )
        .unwrap();
    assert!(b["updatedAt"].as_f64().unwrap() > t);
    // 给 AI 看的列表只有名称和种类
    let idx = st.vault_index().unwrap();
    assert_eq!(idx[0]["title"], "GitHub 改名");
    assert!(idx[0].get("c").is_none() && idx[0].get("n").is_none());
    // 不是条目：不会出现在条目列表和搜索里
    assert!(st.all_items().unwrap().is_empty());

    // 取用请求：没有这条 → 找不到；用户没点之前拿不到内容
    assert!(matches!(
        st.vault_request_create("nope", "", &"p".repeat(44), "claude"),
        Err(StoreError::NotFound(_))
    ));
    let r = st
        .vault_request_create("sec1", "部署要用", &"p".repeat(44), "claude")
        .unwrap();
    let rid = r["id"].as_str().unwrap().to_string();
    assert_eq!(st.vault_request_get(&rid).unwrap()["status"], "pending");
    let p = st.vault_requests_pending();
    assert_eq!(p.len(), 1);
    assert_eq!(p[0]["title"], "GitHub 改名");
    assert_eq!(p[0]["actor"], "claude");
    // 允许但没带加密后的内容：不算
    assert!(matches!(
        st.vault_request_resolve(&rid, true, None, ACTOR_UI),
        Err(StoreError::Invalid(_))
    ));
    st.vault_request_resolve(
        &rid,
        true,
        Some(json!({"epk": "e", "n": "n", "c": "c"})),
        ACTOR_UI,
    )
    .unwrap();
    assert!(st.vault_requests_pending().is_empty());
    let got = st.vault_request_get(&rid).unwrap();
    assert_eq!(got["status"], "approved");
    assert_eq!(got["sealed"]["c"], "c");
    // 取走一次就没了
    assert!(st.vault_request_get(&rid).is_err());
    // 拒绝
    let r = st
        .vault_request_create("sec1", "", &"p".repeat(44), "codex")
        .unwrap();
    let rid = r["id"].as_str().unwrap().to_string();
    st.vault_request_resolve(&rid, false, None, ACTOR_UI)
        .unwrap();
    assert_eq!(st.vault_request_get(&rid).unwrap()["status"], "denied");

    st.vault_delete_secret("sec1", ACTOR_UI).unwrap();
    assert_eq!(st.vault_state().unwrap()["secrets"], json!([]));
    assert!(st.vault_delete_secret("sec1", ACTOR_UI).is_err());
    let _ = fs::remove_dir_all(d);
}

/// 外置硬盘合并带上密码库：只有一边改过的跟着改，两边都改过的留较新的、旧的另存一条
#[test]
fn vault_merges_between_computers() {
    let (da, db, drive) = (tmp("vault-a"), tmp("vault-b"), tmp("vault-drive"));
    let a = Store::open(&da).unwrap();
    let b = Store::open(&db).unwrap();
    a.set_drive_dir(Some(drive.clone()));
    b.set_drive_dir(Some(drive.clone()));
    let merge = |st: &Store| -> Value {
        let p = st.merge_preview().unwrap();
        let file = p["latest"]["file"].as_str().unwrap().to_string();
        st.merge_apply(&file, &HashMap::new()).unwrap()
    };
    let titles = |st: &Store| -> Vec<String> {
        st.vault_state().unwrap()["secrets"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| {
                format!(
                    "{}={}",
                    s["title"].as_str().unwrap(),
                    s["c"].as_str().unwrap()
                )
            })
            .collect()
    };
    let at = |st: &Store, id: &str| -> f64 {
        st.vault_state().unwrap()["secrets"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["id"] == id)
            .unwrap()["updatedAt"]
            .as_f64()
            .unwrap()
    };
    vault_key(&a, "k1abcd");
    for (id, t) in [("sec1", "网站"), ("sec2", "服务器"), ("sec3", "令牌")] {
        a.vault_put_secret(id, &secret("k1abcd", t, "v1", None), ACTOR_UI)
            .unwrap();
    }
    a.backup_to_drive(false).unwrap();
    // 另一台：钥匙和三条都带过来了
    let r = merge(&b);
    assert_eq!(r["other"]["vault"]["keys"], 1);
    assert_eq!(r["other"]["vault"]["secrets"], 3);
    assert_eq!(titles(&b), ["令牌=v1", "服务器=v1", "网站=v1"]);
    b.backup_to_drive(false).unwrap();
    merge(&a);

    // a 改 s1、删 s2；b 改 s1（更晚）、改 s3
    a.vault_put_secret(
        "sec1",
        &secret("k1abcd", "网站", "a2", Some(at(&a, "sec1"))),
        ACTOR_UI,
    )
    .unwrap();
    a.vault_delete_secret("sec2", ACTOR_UI).unwrap();
    a.backup_to_drive(false).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(5));
    b.vault_put_secret(
        "sec1",
        &secret("k1abcd", "网站", "b2", Some(at(&b, "sec1"))),
        ACTOR_UI,
    )
    .unwrap();
    b.vault_put_secret(
        "sec3",
        &secret("k1abcd", "令牌", "b2", Some(at(&b, "sec3"))),
        ACTOR_UI,
    )
    .unwrap();
    let r = merge(&b);
    // s2 只有 a 动过 → 跟着删；s1 两边都改 → 留较新的（b），a 的另存；s3 只有 b 改过 → 不动
    assert_eq!(r["other"]["vault"]["keptOld"], 1);
    assert_eq!(
        titles(&b),
        ["令牌=b2", "网站=b2", "网站（合并时保留的旧版本）=a2"]
    );
    // 再合并一次不会重复另存
    b.backup_to_drive(false).unwrap();
    let r = merge(&a);
    assert_eq!(r["other"]["vault"]["keptOld"], 0);
    assert_eq!(
        titles(&a),
        ["令牌=b2", "网站=b2", "网站（合并时保留的旧版本）=a2"]
    );
    for d in [da, db, drive] {
        let _ = fs::remove_dir_all(d);
    }
}
