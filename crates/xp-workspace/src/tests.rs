use super::*;
use serde_json::json;
use xp_core::templates::{builtin, pick};

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("xp-ws-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d
}

fn assets(name: &str) -> Result<Vec<u8>, String> {
    if name.starts_with("gone") {
        Err("没有".into())
    } else {
        Ok(name.as_bytes().to_vec())
    }
}

#[test]
fn names() {
    assert_eq!(
        suggest_name("leap motor code, remember to reconstruct this project"),
        "leap-motor-code"
    );
    assert_eq!(suggest_name("CAN 报文解析"), "can-baowen-jiexi");
    assert_eq!(
        suggest_name("整理 bao 移植清单"),
        "zhengli-bao-yizhi-qingdan"
    );
    assert_eq!(suggest_name("The Remember"), "new-project");
    assert_eq!(suggest_name("（草稿）"), "caogao");
    assert_eq!(suggest_name("！！"), "new-project");
    assert!(validate_name("leap-motor-code").is_ok());
    assert!(validate_name("a b").is_err());
    assert!(validate_name("con").is_err());
    assert!(validate_name("COM1.x").is_err());
    assert!(validate_name(".hidden").is_err());
    assert!(validate_name("中文").is_err());
}

#[test]
fn refs() {
    let b = "看 ![截图|480](asset:a-1.png) 和 [📎 说明](asset:doc.pdf)\n![](asset:a-1.png)";
    assert_eq!(asset_refs(b), vec!["a-1.png", "doc.pdf"]);
}

#[test]
fn create_sync_and_continue() {
    let root = tmp("flow");
    let t = pick(&builtin(), "rebuild");
    let mut item = json!({"id":"n1","type":"note","title":"leap motor code","tags":["车"],"updatedAt":1.0,
        "body":"leap motor code, remember to reconstruct this project\n\n![截图|480](asset:s1.png)\n\n![](asset:s2.png)"});
    let (dir, ch) = sync(
        None,
        Some(Create {
            root: &root,
            name: "leap-motor-code",
            template: t.clone(),
            host: "http://h:8765",
            git: false,
        }),
        &item,
        &assets,
    )
    .unwrap();
    assert!(ch.first);
    assert_eq!(dir, root.join("leap-motor-code"));
    let x = dir.join(DIR);
    assert_eq!(fs::read(x.join("images/01.png")).unwrap(), b"s1.png");
    assert!(x.join("images/02.png").is_file());
    let note = fs::read_to_string(x.join("note.md")).unwrap();
    assert!(note.contains("![截图](images/01.png)"), "{note}");
    assert!(note.contains("标签：#车"));
    let task = fs::read_to_string(x.join("TASK.md")).unwrap();
    assert!(task.contains("RECONSTRUCTION.md") && task.contains("`n1`"));
    assert!(fs::read_to_string(dir.join("CLAUDE.md"))
        .unwrap()
        .contains(".xpanel/TASK.md"));
    assert!(fs::read_to_string(dir.join(".gitignore"))
        .unwrap()
        .contains(".xpanel/"));
    assert!(fs::read_to_string(x.join(LOG))
        .unwrap()
        .contains("首次生成：2 张截图"));

    // 第一次交给 AI：模板的开场提示词
    let (p, _) = handoff(&dir).unwrap();
    assert_eq!(p, t.prompt);

    // AI 改了 CLAUDE.md：之后不会被覆盖
    fs::write(dir.join("CLAUDE.md"), "我的约定").unwrap();

    // 在中间插一张新图、末尾加一段文字：旧图编号不变，新图是 03
    item["body"] = json!("leap motor code, remember to reconstruct this project\n\n![截图|480](asset:s1.png)\n\n![](asset:s9.jpg)\n\n![](asset:s2.png)\n\n补充：CAN 部分在第三张图");
    item["updatedAt"] = json!(2.0);
    let (_, ch) = sync(Some(&dir), None, &item, &assets).unwrap();
    assert_eq!(ch.new_images, vec![3]);
    assert_eq!(ch.new_text, vec!["补充：CAN 部分在第三张图"]);
    assert!(x.join("images/03.jpg").is_file());
    assert!(fs::read_to_string(x.join("note.md"))
        .unwrap()
        .contains("![](images/03.jpg)\n\n![](images/02.png)"));
    let log = fs::read_to_string(x.join(LOG)).unwrap();
    assert!(
        log.contains("新增 03 号截图、1 段文字")
            && log.contains("images/03.jpg")
            && log.contains("> 补充：CAN"),
        "{log}"
    );
    assert_eq!(
        fs::read_to_string(dir.join("CLAUDE.md")).unwrap(),
        "我的约定"
    );

    // 没变化的同步：不追加更新记录
    let (_, ch) = sync(Some(&dir), None, &item, &assets).unwrap();
    assert!(ch.is_empty());
    assert_eq!(fs::read_to_string(x.join(LOG)).unwrap(), log);

    // 继续：只说新增的部分
    let (p, ch) = handoff(&dir).unwrap();
    assert!(p.starts_with("笔记有更新：新增 03 号截图、1 段文字"), "{p}");
    assert!(p.contains(&t.resume));
    assert_eq!(ch.new_images, vec![3]);
    let (p, _) = handoff(&dir).unwrap();
    assert!(p.starts_with("继续之前的工作"));

    // 读不到的图不占编号
    item["body"] = json!(format!(
        "{}\n\n![](asset:gone.png)\n\n![](asset:s4.png)",
        str_of(&item, "body")
    ));
    let (_, ch) = sync(Some(&dir), None, &item, &assets).unwrap();
    assert_eq!(ch.new_images, vec![4]);
    assert_eq!(ch.missing, vec!["gone.png"]);
    assert_eq!(read_manifest(&dir).unwrap().images["s4.png"], 4);

    // 同名目录：同一条笔记可以重用，别的笔记不行
    let again = sync(
        None,
        Some(Create {
            root: &root,
            name: "leap-motor-code",
            template: t.clone(),
            host: "",
            git: false,
        }),
        &item,
        &assets,
    );
    assert!(again.is_ok());
    let other = json!({"id":"n2","title":"x","body":""});
    assert!(sync(
        None,
        Some(Create {
            root: &root,
            name: "leap-motor-code",
            template: t.clone(),
            host: "",
            git: false
        }),
        &other,
        &assets
    )
    .is_err());
    assert_eq!(
        suggest_path(&root, "leap-motor-code", "n2"),
        root.join("leap-motor-code-2")
    );
    assert_eq!(
        suggest_path(&root, "leap-motor-code", "n1"),
        root.join("leap-motor-code")
    );
    assert_eq!(
        find_project(&dir.join(DIR).join("images")),
        Some(dir.clone())
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn refuses_non_empty_folder() {
    let root = tmp("busy");
    fs::create_dir_all(root.join("p")).unwrap();
    fs::write(root.join("p/readme"), "x").unwrap();
    let item = json!({"id":"n1","title":"t","body":""});
    let r = sync(
        None,
        Some(Create {
            root: &root,
            name: "p",
            template: builtin().remove(0),
            host: "",
            git: false,
        }),
        &item,
        &assets,
    );
    assert!(r.unwrap_err().contains("不是空文件夹"));
    let _ = fs::remove_dir_all(root);
}
