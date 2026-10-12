//! 后台跑 Claude Code 时边跑边看：它每一步在做什么报给界面；它要做需要点头的事（运行命令、读写工作目录外的文件）时先问用户。
//!
//! 用的是 claude 自己的流式接口：`-p --input-format stream-json --output-format stream-json --permission-prompt-tool stdio`。
//! 标准输出一行一个 JSON 事件；要确认时发一条 `control_request`（can_use_tool），我们往标准输入回一条 `control_response`。
//! 别的 AI 命令行没有这个接口，还是老办法一次问完（agent.rs 的 ask）。

use crate::agent::{exe_is, parse_claude, Answer};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::Child;
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// 界面那一头：看进展、回答要不要允许、有没有点停止
pub trait Watch: Send + Sync {
    /// kind：tool（在用一个工具）、text（它说的话）、error（这一步没成）
    fn step(&self, kind: &str, label: &str, text: &str);
    /// 要不要允许这一步。一直等到用户回答；Err 里是告诉 AI 的拒绝原因
    fn permit(&self, tool: &str, input: &Value) -> Result<(), String>;
    fn stopped(&self) -> bool;
}

/// 这条命令能不能边跑边看：是 claude 的非交互模式，而且用户没有自己指定输出格式或确认方式
pub fn can_stream(cmdline: &str) -> bool {
    let t = cmdline.trim_end();
    exe_is(t, "claude")
        && (t.contains(" -p") || t.contains(" --print"))
        && !["--output-format", "--input-format", "--permission-prompt"]
            .iter()
            .any(|f| t.contains(f))
}

pub fn with_stream(cmdline: &str) -> String {
    format!(
        "{} --input-format stream-json --output-format stream-json --verbose --permission-prompt-tool stdio",
        cmdline.trim_end()
    )
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("")
}

fn clip(t: &str, n: usize) -> String {
    let t = t.trim();
    if t.chars().count() <= n {
        return t.to_string();
    }
    let mut out: String = t.chars().take(n).collect();
    out.push('…');
    out
}

/// 一步操作给人看的说法：做什么（短）、对象（命令、路径、网址…）
pub fn describe(tool: &str, input: &Value) -> (String, String) {
    let path = || {
        let p = s(input, "file_path");
        (if p.is_empty() { s(input, "path") } else { p }).to_string()
    };
    if let Some(name) = tool.strip_prefix("mcp__xpanel__") {
        let what = match name.trim_start_matches("xpanel_") {
            "list_items" | "get_item" | "stats" | "taxonomy" | "export" | "audit" => "查工作台",
            "create_items" => "在工作台里新建",
            "update_item" | "complete_item" | "reprioritize" => "改工作台里的条目",
            "delete_item" => "删工作台里的条目",
            _ => "用工作台",
        };
        let detail = input
            .get("items")
            .and_then(|x| x.as_array())
            .map(|a| {
                a.iter()
                    .map(|i| s(i, "title"))
                    .filter(|t| !t.is_empty())
                    .collect::<Vec<_>>()
                    .join("、")
            })
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| {
                let id = s(input, "id");
                if id.is_empty() {
                    s(input, "q").to_string()
                } else {
                    id.to_string()
                }
            });
        return (what.into(), clip(&detail, 300));
    }
    if let Some(rest) = tool.strip_prefix("mcp__") {
        let (server, name) = rest.split_once("__").unwrap_or((rest, ""));
        let known = match name {
            "docx_builtin_search" => Some("搜飞书文档"),
            "docx_v1_document_rawContent" => Some("读飞书文档"),
            "docx_builtin_import" => Some("在飞书里新建文档"),
            "wiki_v1_node_search" => Some("搜飞书知识库"),
            "wiki_v2_space_getNode" => Some("读飞书知识库"),
            "drive_v1_permissionMember_create" => Some("给飞书文档加协作者"),
            _ => None,
        };
        let what = match known {
            Some(k) => k.to_string(),
            None if name.is_empty() => format!("用外部工具 {server}"),
            None => format!("用 {server} 的 {name}"),
        };
        return (what, clip(&input.to_string(), 300));
    }
    let cmd = s(input, "command");
    if !cmd.is_empty() {
        return ("运行命令".into(), clip(cmd, 2000));
    }
    match tool {
        "Read" => ("读文件".into(), path()),
        "Write" => ("写文件".into(), path()),
        "Edit" | "MultiEdit" | "NotebookEdit" => ("改文件".into(), {
            let p = path();
            if p.is_empty() {
                s(input, "notebook_path").to_string()
            } else {
                p
            }
        }),
        "Glob" => ("找文件".into(), {
            let d = s(input, "path");
            let p = s(input, "pattern");
            if d.is_empty() {
                p.to_string()
            } else {
                format!("{p}（在 {d}）")
            }
        }),
        "Grep" => ("搜内容".into(), {
            let d = s(input, "path");
            let p = s(input, "pattern");
            if d.is_empty() {
                p.to_string()
            } else {
                format!("{p}（在 {d}）")
            }
        }),
        "WebFetch" => ("打开网页".into(), s(input, "url").to_string()),
        "WebSearch" => ("搜索网页".into(), s(input, "query").to_string()),
        "Task" | "Agent" => ("分给子任务".into(), s(input, "description").to_string()),
        "TodoWrite" => ("列步骤".into(), String::new()),
        _ => (format!("用 {tool}"), clip(&input.to_string(), 300)),
    }
}

/// 「以后同类的都允许」里的同类是什么：返回（记住用的 key，给人看的说法）。
/// 命令按开头算：`git log -1`、`git -C 目录 log` → 「git log」命令；带管道、分号、重定向这类的只认一模一样的这一条。
/// 别的工具按工具算（读文件、写文件…）。
pub fn kind_of(tool: &str, input: &Value) -> (String, String) {
    let cmd = s(input, "command").trim();
    if cmd.is_empty() {
        let (what, _) = describe(tool, input);
        return (tool.to_string(), format!("「{what}」"));
    }
    let plain = !cmd.chars().any(|c| ";&|<>$`(){}\n\r".contains(c));
    if !plain {
        return (format!("{tool}={cmd}"), "这一条命令".into());
    }
    let words: Vec<&str> = cmd.split_whitespace().collect();
    let first = words.first().copied().unwrap_or("");
    let sub_like =
        |w: &&str| w.chars().all(|c| c.is_ascii_alphabetic() || c == '-') && !w.starts_with('-');
    // 第二个词像子命令（git log、npm run、cargo test）就带上，免得允许了 git log 等于允许了 git push。
    // git 常写成 git -C 目录 log：跳过前面的选项找到子命令
    let second = if first == "git" {
        let mut i = 1;
        let mut found = None;
        while i < words.len() {
            let w = words[i];
            if w == "-C" || w == "-c" {
                i += 2;
            } else if w.starts_with('-') {
                i += 1;
            } else {
                found = Some(w).filter(sub_like);
                break;
            }
        }
        found
    } else {
        words.get(1).copied().filter(sub_like)
    };
    let head = match second {
        Some(w) => format!("{first} {w}"),
        None => first.to_string(),
    };
    (format!("{tool}:{head}"), format!("「{head}」命令"))
}

/// 记住的 key 管不管这一次
pub fn covered(keys: &std::collections::HashSet<String>, tool: &str, input: &Value) -> bool {
    keys.contains(&kind_of(tool, input).0)
}

fn kill(child: &mut Child) {
    // Windows 上我们起的是 cmd，真正的 claude 是它的子进程：连同子进程一起结束
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .creation_flags(0x0800_0000)
            .output();
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn tail(t: &str, n: usize) -> String {
    let c: Vec<char> = t.trim().chars().collect();
    c[c.len().saturating_sub(n)..].iter().collect()
}

/// 跑到出结果为止。idle：多少秒一点动静都没有就算卡住（等用户点允许的时间不算）
pub fn drive(
    mut child: Child,
    prompt: &str,
    watch: &dyn Watch,
    idle: u64,
) -> Result<Answer, String> {
    let mut stdin = child.stdin.take().ok_or("拿不到 AI 的输入")?;
    let stdout = child.stdout.take().ok_or("拿不到 AI 的输出")?;
    let mut stderr = child.stderr.take().ok_or("拿不到 AI 的输出")?;
    let first = json!({"type": "user", "message": {"role": "user", "content": prompt}});
    let send = |i: &mut std::process::ChildStdin, v: &Value| -> Result<(), String> {
        i.write_all(format!("{v}\n").as_bytes())
            .and_then(|_| i.flush())
            .map_err(|e| format!("和 AI 的连接断了：{e}"))
    };
    send(&mut stdin, &first)?;
    let (tx, rx) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    let errs = std::thread::spawn(move || {
        let mut b = vec![];
        let _ = std::io::Read::read_to_end(&mut stderr, &mut b);
        String::from_utf8_lossy(&b).to_string()
    });
    let mut last = Instant::now();
    let mut done: Option<Result<Answer, String>> = None;
    loop {
        if watch.stopped() {
            kill(&mut child);
            return Err("已停止".into());
        }
        let line = match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(l) => l,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if last.elapsed().as_secs() > idle {
                    kill(&mut child);
                    return Err(format!("{idle} 秒没有任何动静，已停止"));
                }
                continue;
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        };
        last = Instant::now();
        let Ok(v) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        match s(&v, "type") {
            "assistant" => {
                let blocks = v.pointer("/message/content").and_then(|x| x.as_array());
                for b in blocks.into_iter().flatten() {
                    match s(b, "type") {
                        "tool_use" => {
                            let (what, detail) =
                                describe(s(b, "name"), b.get("input").unwrap_or(&Value::Null));
                            watch.step("tool", &what, &clip(&detail, 300));
                        }
                        "text" if !s(b, "text").trim().is_empty() => {
                            watch.step("text", "", &clip(s(b, "text"), 400))
                        }
                        _ => {}
                    }
                }
            }
            "user" => {
                let blocks = v.pointer("/message/content").and_then(|x| x.as_array());
                for b in blocks.into_iter().flatten() {
                    if s(b, "type") == "tool_result"
                        && b.get("is_error").and_then(|x| x.as_bool()) == Some(true)
                    {
                        let t = match b.get("content") {
                            Some(Value::String(t)) => t.clone(),
                            Some(Value::Array(a)) => {
                                a.iter().map(|x| s(x, "text")).collect::<Vec<_>>().join(" ")
                            }
                            _ => String::new(),
                        };
                        watch.step("error", "这一步没成", &clip(&t, 300));
                    }
                }
            }
            "control_request" => {
                let id = s(&v, "request_id").to_string();
                let req = v.get("request").cloned().unwrap_or(Value::Null);
                let reply = if s(&req, "subtype") == "can_use_tool" {
                    let input = req.get("input").cloned().unwrap_or(Value::Null);
                    let answer = match watch.permit(s(&req, "tool_name"), &input) {
                        Ok(()) => json!({"behavior": "allow", "updatedInput": input}),
                        Err(why) => json!({"behavior": "deny", "message": why}),
                    };
                    // 等人点的时间不算卡住
                    last = Instant::now();
                    json!({"subtype": "success", "request_id": id, "response": answer})
                } else {
                    json!({"subtype": "error", "request_id": id, "error": "xpanel 不支持这种请求"})
                };
                send(
                    &mut stdin,
                    &json!({"type": "control_response", "response": reply}),
                )?;
            }
            "result" => {
                done = parse_claude(&line);
                break;
            }
            _ => {}
        }
    }
    drop(stdin);
    // 出了结果它自己会退出；等一小会儿，不退就结束它
    let until = Instant::now() + Duration::from_secs(5);
    while child.try_wait().ok().flatten().is_none() {
        if Instant::now() > until {
            kill(&mut child);
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    match done {
        Some(r) => r,
        None => {
            let e = tail(&errs.join().unwrap_or_default(), 600);
            Err(if e.is_empty() {
                "AI 没有返回内容就结束了".into()
            } else {
                e
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[test]
    fn only_plain_claude_print_is_streamed() {
        assert!(can_stream("claude -p"));
        assert!(can_stream(
            "claude -p --mcp-config .xpanel/mcp.json --allowedTools mcp__xpanel"
        ));
        assert!(!can_stream("claude -p --output-format json"));
        assert!(!can_stream("claude"));
        assert!(!can_stream("codex exec -"));
        assert!(with_stream("claude -p ").ends_with("-p --input-format stream-json --output-format stream-json --verbose --permission-prompt-tool stdio"));
    }

    #[test]
    fn describes_steps_for_people() {
        assert_eq!(
            describe("Bash", &json!({"command": "git log -1"})),
            ("运行命令".into(), "git log -1".into())
        );
        assert_eq!(
            describe("Read", &json!({"file_path": "/a/b.md"})),
            ("读文件".into(), "/a/b.md".into())
        );
        assert_eq!(
            describe("Glob", &json!({"pattern": "**/.git", "path": "/work"})),
            ("找文件".into(), "**/.git（在 /work）".into())
        );
        assert_eq!(
            describe("mcp__feishu__docx_builtin_search", &json!({"q": "周会"})).0,
            "搜飞书文档"
        );
        assert_eq!(
            describe("mcp__slack__post", &json!({})).0,
            "用 slack 的 post"
        );
        assert_eq!(
            describe(
                "mcp__xpanel__xpanel_create_items",
                &json!({"items": [{"title": "文档站"}, {"title": "知识库"}]})
            ),
            ("在工作台里新建".into(), "文档站、知识库".into())
        );
    }

    #[test]
    fn same_kind_is_narrow_for_commands() {
        let k = |c: &str| kind_of("Bash", &json!({ "command": c }));
        assert_eq!(
            k("git log -1 --oneline"),
            ("Bash:git log".into(), "「git log」命令".into())
        );
        assert_eq!(k("git remote -v").0, "Bash:git remote");
        assert_eq!(k("ls -la /work").0, "Bash:ls");
        assert_eq!(k("git -C /work/a log -1").0, "Bash:git log");
        assert_eq!(
            k("git -C /work/a -c core.pager=cat remote -v").0,
            "Bash:git remote"
        );
        assert_eq!(k("git --version").0, "Bash:git");
        // 拼起来的命令只认这一条，免得借着 git log 的名义跑别的
        assert_eq!(k("git log | sh").0, "Bash=git log | sh");
        assert_eq!(k("git log; rm -rf x").1, "这一条命令");
        assert_eq!(
            kind_of("Read", &json!({"file_path": "/x"})),
            ("Read".into(), "「读文件」".into())
        );
        let mut keys = std::collections::HashSet::new();
        keys.insert("Bash:git log".to_string());
        assert!(covered(
            &keys,
            "Bash",
            &json!({"command": "git log --stat"})
        ));
        assert!(covered(
            &keys,
            "Bash",
            &json!({"command": "git -C /other log"})
        ));
        assert!(!covered(
            &keys,
            "Bash",
            &json!({"command": "git -C /other push"})
        ));
        assert!(!covered(&keys, "Bash", &json!({"command": "git push"})));
        assert!(!covered(
            &keys,
            "Bash",
            &json!({"command": "git log && git push"})
        ));
    }

    struct Fake {
        steps: Mutex<Vec<String>>,
        allow: bool,
    }
    impl Watch for Fake {
        fn step(&self, kind: &str, label: &str, text: &str) {
            self.steps
                .lock()
                .unwrap()
                .push(format!("{kind}|{label}|{text}"));
        }
        fn permit(&self, tool: &str, _: &Value) -> Result<(), String> {
            self.steps.lock().unwrap().push(format!("ask|{tool}"));
            if self.allow {
                Ok(())
            } else {
                Err("不行".into())
            }
        }
        fn stopped(&self) -> bool {
            false
        }
    }

    /// 用一段脚本装成 claude：先报一步、再问能不能运行命令，把我们的回答原样带进结果里
    #[cfg(unix)]
    fn fake_claude() -> Child {
        let script = r#"read first
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"我先看看"},{"type":"tool_use","name":"Bash","input":{"command":"git status"}}]}}'
echo '{"type":"control_request","request_id":"r1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"git status"}}}'
read answer
case "$answer" in *'"behavior":"allow"'*) said=yes ;; *) said=no ;; esac
echo '{"type":"user","message":{"content":[{"type":"tool_result","is_error":true,"content":"exit 1"}]}}'
echo "{\"type\":\"result\",\"is_error\":false,\"result\":\"allowed=$said\",\"usage\":{\"input_tokens\":3,\"output_tokens\":5}}"
"#;
        std::process::Command::new("sh")
            .arg("-c")
            .arg(script)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap()
    }

    #[cfg(unix)]
    #[test]
    fn reports_steps_and_answers_permission_requests() {
        for allow in [true, false] {
            let w = Fake {
                steps: Mutex::new(vec![]),
                allow,
            };
            let a = drive(fake_claude(), "做点事", &w, 10).unwrap();
            assert_eq!(a.text, if allow { "allowed=yes" } else { "allowed=no" });
            assert_eq!(a.usage.unwrap().output, 5);
            assert_eq!(
                *w.steps.lock().unwrap(),
                vec![
                    "text||我先看看",
                    "tool|运行命令|git status",
                    "ask|Bash",
                    "error|这一步没成|exit 1"
                ]
            );
        }
    }

    /// 对着真的 claude 走一遍（要本机装了并登录，平时不跑）：cargo test -p xpanel real_claude -- --ignored --nocapture
    #[test]
    #[ignore = "needs a logged-in claude on this machine"]
    fn real_claude_asks_before_writing() {
        let dir = std::env::temp_dir().join(format!("xp-live-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let w = Fake {
            steps: Mutex::new(vec![]),
            allow: true,
        };
        let a = crate::agent::Agent {
            name: "Claude Code".into(),
            cmd: "claude".into(),
            ask: String::new(),
        };
        let out = crate::agent::ask(
            &a,
            &dir.to_string_lossy(),
            "在当前目录新建文件 hello.txt，内容是 hi，然后用一句话说做完了。",
            &[],
            crate::agent::Extras {
                watch: Some(&w),
                ..Default::default()
            },
            120,
        )
        .unwrap();
        println!("{:#?}\n{}", w.steps.lock().unwrap(), out.text);
        assert!(dir.join("hello.txt").is_file());
        assert!(w.steps.lock().unwrap().iter().any(|x| x == "ask|Write"));
        assert!(out.usage.is_some());
        // 接着同一次对话问：它记得刚才做了什么
        let again = crate::agent::ask(
            &a,
            &dir.to_string_lossy(),
            "你刚才新建的文件叫什么？只回答文件名。",
            &[],
            crate::agent::Extras {
                watch: Some(&w),
                resume: out.session.as_deref(),
                ..Default::default()
            },
            120,
        )
        .unwrap();
        println!("{}", again.text);
        assert!(again.text.contains("hello.txt"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn stops_when_asked_and_when_silent() {
        struct Stop;
        impl Watch for Stop {
            fn step(&self, _: &str, _: &str, _: &str) {}
            fn permit(&self, _: &str, _: &Value) -> Result<(), String> {
                Ok(())
            }
            fn stopped(&self) -> bool {
                true
            }
        }
        let sleeper = || {
            std::process::Command::new("sh")
                .arg("-c")
                .arg("read x; sleep 30")
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .unwrap()
        };
        assert_eq!(drive(sleeper(), "x", &Stop, 10).unwrap_err(), "已停止");
        let w = Fake {
            steps: Mutex::new(vec![]),
            allow: true,
        };
        assert!(drive(sleeper(), "x", &w, 0)
            .unwrap_err()
            .contains("没有任何动静"));
    }
}
