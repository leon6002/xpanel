use super::*;
use crate::inbox::MessageQuery;
use serde_json::json;
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
    // 设置冷备份位置后马上补一份当天的
    assert_eq!(
        cold.join("xpanel-backup/backups")
            .read_dir()
            .unwrap()
            .count(),
        1
    );
    let p = st.backup_now("2000-01-01").unwrap();
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
    assert!(st.put_asset("../x", b"").is_err());
    let _ = fs::remove_dir_all(d);
    let _ = fs::remove_dir_all(cold);
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
    let p: Map<String, Value> = serde_json::from_value(json!({"name":"GLWINHONOR","description":"主力工作机","networks":[{"name":"家里","ip":"192.168.1.37"}]})).unwrap();
    st.update_device(&id, &p, "ui").unwrap();
    let it = st.get("a").unwrap();
    assert_eq!(it["device"], "GLWINHONOR");
    assert_eq!(it["updatedAt"], 1.0);
    assert_eq!(
        st.list(&Filter {
            device: Some("GLWINHONOR".into()),
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
