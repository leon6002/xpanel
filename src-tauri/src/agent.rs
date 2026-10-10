//! 交给 AI：在新的终端窗口里启动 AI 命令行，提示词通过临时文件传进去（不怕引号和换行）

use serde::{Deserialize, Serialize};
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Agent {
    pub name: String,
    pub cmd: String,
    /// 问答用的非交互命令（提示词从标准输入传进去），如 `claude -p`；不填按 cmd 推断
    pub ask: String,
}

pub fn default_agents() -> Vec<Agent> {
    let a = |n: &str, c: &str| Agent {
        name: n.into(),
        cmd: c.into(),
        ask: String::new(),
    };
    vec![
        a("Claude Code", "claude {prompt}"),
        a("Codex", "codex {prompt}"),
        a("DeepSeek Harness", "dsh {prompt}"),
        a("ChatGPT", "https://chatgpt.com/?q={prompt}"),
    ]
}

/// PATH 里有没有这个程序（Windows 上找 PowerShell 7 用）
#[cfg(windows)]
fn in_path(exe: &str) -> bool {
    std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).any(|d| d.join(exe).is_file()))
        .unwrap_or(false)
}

pub fn pct_encode(s: &str) -> String {
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

fn stamp() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

/// 在新的终端窗口里启动 AI 命令行，提示词通过临时文件传进去（不怕引号和换行）
pub fn launch_terminal(agent: &Agent, cwd: &str, prompt: &str) -> Result<(), String> {
    let dir = std::env::temp_dir().join("xpanel-agent");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let id = stamp();
    let pf = dir.join(format!("prompt-{id}.txt"));
    fs::write(&pf, prompt).map_err(|e| e.to_string())?;
    let name = agent.name.replace('\'', "");

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let q = |s: &str| format!("'{}'", s.replace('\'', "''"));
        let mut ps = String::from("\u{feff}");
        ps += &format!(
            "$Host.UI.RawUI.WindowTitle = {}\r\n",
            q(&format!("xpanel → {name}"))
        );
        if !cwd.trim().is_empty() {
            ps += &format!("Set-Location -LiteralPath {}\r\n", q(cwd.trim()));
        }
        ps += &format!(
            "$p = Get-Content -Raw -Encoding UTF8 -LiteralPath {}\r\n",
            q(&pf.to_string_lossy())
        );
        // 优先用 PowerShell 7；只有 Windows PowerShell 5.1 传给外部程序时会弄丢英文双引号，才换成中文引号
        let pwsh = in_path("pwsh.exe");
        if !pwsh {
            ps += "$p = $p -replace '\"', '”'\r\n";
        }
        ps += &format!(
            "Write-Host {} -ForegroundColor Cyan\r\n",
            q(&format!(
                "已交给 {name}，工作目录：{}",
                if cwd.trim().is_empty() {
                    "（默认）"
                } else {
                    cwd.trim()
                }
            ))
        );
        ps += &agent.cmd.replace("{prompt}", "$p");
        ps += "\r\n";
        let script = dir.join(format!("run-{id}.ps1"));
        fs::write(&script, ps).map_err(|e| e.to_string())?;
        std::process::Command::new(if pwsh { "pwsh.exe" } else { "powershell.exe" })
            .args([
                "-NoExit",
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ])
            .arg(&script)
            .creation_flags(0x0000_0010) // 新的控制台窗口
            .spawn()
            .map_err(|e| format!("启动失败：{e}"))?;
        return Ok(());
    }
    #[cfg(not(windows))]
    {
        let q = |s: &str| format!("'{}'", s.replace('\'', "'\\''"));
        let mut sh = String::from("#!/bin/bash\n");
        if !cwd.trim().is_empty() {
            sh += &format!("cd {} || exit 1\n", q(cwd.trim()));
        }
        sh += &format!("P=\"$(cat {})\"\n", q(&pf.to_string_lossy()));
        sh += &format!("echo {}\n", q(&format!("已交给 {name}")));
        sh += &agent.cmd.replace("{prompt}", "\"$P\"");
        sh += "\nexec $SHELL\n";
        let script = dir.join(format!("run-{id}.command"));
        fs::write(&script, sh).map_err(|e| e.to_string())?;
        let _ = std::process::Command::new("chmod")
            .arg("+x")
            .arg(&script)
            .status();
        let r = if cfg!(target_os = "macos") {
            std::process::Command::new("open")
                .args(["-a", "Terminal"])
                .arg(&script)
                .spawn()
        } else {
            std::process::Command::new("x-terminal-emulator")
                .arg("-e")
                .arg(&script)
                .spawn()
        };
        r.map(|_| ()).map_err(|e| format!("启动失败：{e}"))
    }
}

// ---------------------------------------------------------------- 问答：不开窗口，拿回答案

/// 问答用的命令：配置里写了就用，否则按常见的命令行推断
pub fn ask_command(a: &Agent) -> Option<String> {
    let ask = a.ask.trim();
    if !ask.is_empty() {
        return Some(ask.to_string());
    }
    let first = a
        .cmd
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    let exe = first
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .trim_end_matches(".exe")
        .trim_end_matches(".cmd");
    match exe {
        "claude" => Some("claude -p".into()),
        "codex" => Some("codex exec -".into()),
        _ => None,
    }
}

/// 问答时笔记（和关联条目）里的图片、附件放在工作目录的这个子目录（界面写提示词时用同样的相对路径）
pub const ASK_FILES: &str = ".xpanel/ask-files";

fn exe_is(cmdline: &str, name: &str) -> bool {
    cmdline.split_whitespace().next().is_some_and(|x| {
        x.trim_matches('"')
            .trim_end_matches(".exe")
            .trim_end_matches(".cmd")
            .rsplit(['/', '\\'])
            .next()
            .is_some_and(|b| b.eq_ignore_ascii_case(name))
    })
}

/// codex exec 看不了文件里的图片，要用 -i 附上：插在最后的「-」（从标准输入读提示词）前面
fn with_images(cmdline: &str, images: &[std::path::PathBuf]) -> String {
    let t = cmdline.trim_end();
    if images.is_empty() || !exe_is(t, "codex") || !t.contains(" exec") || !t.ends_with(" -") {
        return cmdline.to_string();
    }
    // -i 只能附图片；PDF 之类的附件 codex 自己去读文件
    let args: String = images
        .iter()
        .filter(|p| {
            p.extension().and_then(|e| e.to_str()).is_some_and(|e| {
                matches!(
                    e.to_ascii_lowercase().as_str(),
                    "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp"
                )
            })
        })
        .map(|p| format!(" -i \"{}\"", p.to_string_lossy()))
        .collect();
    if args.is_empty() {
        return cmdline.to_string();
    }
    format!("{}{} -", &t[..t.len() - 2], args)
}

/// 一次问答用了多少 token（拿不到时整个为空）
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct Usage {
    /// 输入（含缓存命中的部分）
    pub input: u64,
    pub output: u64,
    /// 输入里有多少是缓存命中的
    pub cached: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Answer {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<Usage>,
}

/// 怎么拿到用量：claude 加 --output-format json（一整段 JSON，里面有 result 和 usage）；
/// codex 加 --json（事件流里有 token 用量）和 -o 文件（最后的回答）。别的命令原样输出。
enum Stats {
    None,
    Claude,
    Codex(std::path::PathBuf),
}

fn with_stats(cmdline: &str) -> (String, Stats) {
    let t = cmdline.trim_end();
    if exe_is(t, "claude")
        && (t.contains(" -p") || t.contains(" --print"))
        && !t.contains("--output-format")
    {
        return (format!("{t} --output-format json"), Stats::Claude);
    }
    if exe_is(t, "codex")
        && t.contains(" exec")
        && t.ends_with(" -")
        && !t.contains("--json")
        && !t.contains(" -o ")
    {
        let f = std::env::temp_dir().join(format!(
            "xpanel-codex-{}-{}.txt",
            std::process::id(),
            now_nanos()
        ));
        return (
            format!(
                "{} --json -o \"{}\" -",
                &t[..t.len() - 2],
                f.to_string_lossy()
            ),
            Stats::Codex(f),
        );
    }
    (cmdline.to_string(), Stats::None)
}

fn now_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

fn num(v: &serde_json::Value, k: &str) -> u64 {
    v.get(k).and_then(|x| x.as_u64()).unwrap_or(0)
}

/// claude -p --output-format json 的输出
fn parse_claude(out: &str) -> Option<Result<Answer, String>> {
    let v: serde_json::Value = serde_json::from_str(out.trim()).ok()?;
    let text = v.get("result")?.as_str()?.trim().to_string();
    if v.get("is_error").and_then(|x| x.as_bool()) == Some(true) {
        return Some(Err(if text.is_empty() {
            "AI 返回了错误".into()
        } else {
            text
        }));
    }
    let usage = v.get("usage").map(|u| {
        let cached = num(u, "cache_read_input_tokens");
        Usage {
            input: num(u, "input_tokens") + num(u, "cache_creation_input_tokens") + cached,
            output: num(u, "output_tokens"),
            cached,
            cost_usd: v.get("total_cost_usd").and_then(|x| x.as_f64()),
        }
    });
    Some(Ok(Answer { text, usage }))
}

/// codex exec --json 的事件流：找最后一个带 input_tokens / output_tokens 的用量，和最后一条回答
fn parse_codex(out: &str) -> (Option<String>, Option<Usage>) {
    fn find_usage(v: &serde_json::Value) -> Option<Usage> {
        match v {
            serde_json::Value::Object(m) => {
                // 旧版的 token_count 事件里 total_token_usage 才是整次的总数
                if let Some(t) = m.get("total_token_usage") {
                    if let Some(u) = find_usage(t) {
                        return Some(u);
                    }
                }
                if m.get("input_tokens").is_some_and(|x| x.is_u64())
                    && m.get("output_tokens").is_some_and(|x| x.is_u64())
                {
                    return Some(Usage {
                        input: num(v, "input_tokens"),
                        output: num(v, "output_tokens"),
                        cached: num(v, "cached_input_tokens"),
                        cost_usd: None,
                    });
                }
                m.values().find_map(find_usage)
            }
            serde_json::Value::Array(a) => a.iter().find_map(find_usage),
            _ => None,
        }
    }
    let mut usage = None;
    let mut text = None;
    for line in out.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
            continue;
        };
        if let Some(u) = find_usage(&v) {
            usage = Some(u);
        }
        // 新版：{"type":"item.completed","item":{"type":"agent_message","text":…}}；旧版：{"msg":{"type":"agent_message","message":…}}
        for it in [v.get("item"), v.get("msg")].into_iter().flatten() {
            if it.get("type").and_then(|x| x.as_str()) == Some("agent_message") {
                if let Some(t) = it
                    .get("text")
                    .or_else(|| it.get("message"))
                    .and_then(|x| x.as_str())
                {
                    text = Some(t.trim().to_string());
                }
            }
        }
    }
    (text, usage)
}

/// AI 命令行常装在哪些文件夹。桌面程序拿到的 PATH 常常不全（装完没重启、macOS 上从图标启动的程序只有系统自带的 PATH），
/// 终端里能用的命令这里可能找不到，所以把这些常见位置也算上。只返回存在的文件夹
pub fn tool_dirs(env: &dyn Fn(&str) -> Option<String>) -> Vec<std::path::PathBuf> {
    use std::path::PathBuf;
    let mut out: Vec<PathBuf> = vec![];
    let mut add = |base: Option<String>, rest: &str| {
        if let Some(b) = base.filter(|b| !b.trim().is_empty()) {
            let d = if rest.is_empty() {
                PathBuf::from(b)
            } else {
                PathBuf::from(b).join(rest)
            };
            if d.is_dir() && !out.contains(&d) {
                out.push(d);
            }
        }
    };
    let home = env("USERPROFILE").or_else(|| env("HOME"));
    // Claude Code 的安装程序、旧的本地安装
    add(home.clone(), ".local/bin");
    add(home.clone(), ".claude/local");
    // npm、pnpm、bun、volta、scoop、winget 装的全局命令
    add(env("APPDATA"), "npm");
    add(env("LOCALAPPDATA"), "pnpm");
    add(env("PNPM_HOME"), "");
    add(home.clone(), ".bun/bin");
    add(home.clone(), ".volta/bin");
    add(home.clone(), "scoop/shims");
    add(env("LOCALAPPDATA"), "Microsoft/WinGet/Links");
    add(env("NVM_SYMLINK"), "");
    add(env("ProgramFiles"), "nodejs");
    add(home.clone(), ".npm-global/bin");
    add(home, ".cargo/bin");
    if !cfg!(windows) {
        for d in ["/opt/homebrew/bin", "/usr/local/bin"] {
            add(Some(d.into()), "");
        }
    }
    out
}

/// 在这些文件夹里找一个命令（Windows 上按 .exe / .cmd / .bat / .ps1 以外的可执行后缀都试一遍）
pub fn find_program(
    name: &str,
    dirs: &[std::path::PathBuf],
    exts: &[&str],
) -> Option<std::path::PathBuf> {
    for d in dirs {
        for e in exts {
            let f = d.join(format!("{name}{e}"));
            if f.is_file() {
                return Some(f);
            }
        }
    }
    None
}

/// 命令行的第一个词（程序名）；带路径的、带引号的原样返回，由调用方判断
fn program_of(cmdline: &str) -> &str {
    let t = cmdline.trim_start();
    if let Some(rest) = t.strip_prefix('"') {
        return rest.split('"').next().unwrap_or("");
    }
    t.split_whitespace().next().unwrap_or("")
}

/// 跑命令之前：把常见的安装位置补进 PATH，返回新的 PATH；程序名（不带路径的）哪里都找不到就报清楚的错
fn prepare_path(cmdline: &str) -> Result<Option<std::ffi::OsString>, String> {
    let env = |k: &str| std::env::var(k).ok();
    let current: Vec<std::path::PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    let extra: Vec<std::path::PathBuf> = tool_dirs(&env)
        .into_iter()
        .filter(|d| !current.contains(d))
        .collect();
    let prog = program_of(cmdline);
    let bare = !prog.is_empty() && !prog.contains(['/', '\\', ':']);
    if bare {
        let exts: &[&str] = if cfg!(windows) {
            &[".exe", ".cmd", ".bat", ".com", ""]
        } else {
            &[""]
        };
        let mut all = current.clone();
        all.extend(extra.iter().cloned());
        if find_program(prog, &all, exts).is_none() {
            let how = if cfg!(windows) { "where" } else { "which" };
            return Err(format!(
                "这台电脑上没找到「{prog}」这个命令。\n1. 先确认装了：打开终端运行 {prog} --version。没装的话先装上，并在终端里登录一次。\n2. 装了还是找不到：在终端运行 {how} {prog}，把得到的完整路径填到「设置」里这个 AI 的「问答命令」，比如 C:\\Users\\你\\.local\\bin\\{prog}.exe -p；改完再试。"
            ));
        }
    }
    if extra.is_empty() {
        return Ok(None);
    }
    let mut all = current;
    all.extend(extra);
    std::env::join_paths(all)
        .map(Some)
        .map_err(|e| e.to_string())
}

/// 跑一次非交互的 AI 命令：提示词从标准输入传进去，返回标准输出。最多等 timeout 秒。
pub fn ask(
    a: &Agent,
    cwd: &str,
    prompt: &str,
    images: &[std::path::PathBuf],
    timeout: u64,
) -> Result<Answer, String> {
    use std::io::{Read, Write};
    use std::process::{Command, Stdio};
    let cmdline = ask_command(a).ok_or_else(|| {
        format!(
            "「{}」不支持直接问答，在设置里给它填一个问答命令（比如 claude -p）",
            a.name
        )
    })?;
    let path = prepare_path(&cmdline)?;
    let (cmdline, stats) = with_stats(&with_images(&cmdline, images));
    let mut c = if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(&cmdline);
        c
    } else {
        let mut c = Command::new("sh");
        c.arg("-c").arg(&cmdline);
        c
    };
    if let Some(p) = path {
        c.env("PATH", p);
    }
    let dir = std::path::Path::new(cwd.trim());
    if !cwd.trim().is_empty() && dir.is_dir() {
        c.current_dir(dir);
    } else {
        let t = std::env::temp_dir().join("xpanel-ask");
        let _ = fs::create_dir_all(&t);
        c.current_dir(t);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // 不弹黑窗口
    }
    let mut child = c
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动「{cmdline}」失败：{e}"))?;
    if let Some(mut i) = child.stdin.take() {
        let p = prompt.to_string();
        std::thread::spawn(move || {
            let _ = i.write_all(p.as_bytes());
        });
    }
    let mut out = child.stdout.take().unwrap();
    let mut err = child.stderr.take().unwrap();
    let to = std::thread::spawn(move || {
        let mut b = vec![];
        let _ = out.read_to_end(&mut b);
        b
    });
    let te = std::thread::spawn(move || {
        let mut b = vec![];
        let _ = err.read_to_end(&mut b);
        b
    });
    let start = std::time::Instant::now();
    let status = loop {
        if let Some(s) = child.try_wait().map_err(|e| e.to_string())? {
            break s;
        }
        if start.elapsed().as_secs() > timeout {
            let _ = child.kill();
            return Err(format!("等了 {timeout} 秒还没回答，已停止"));
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    };
    let out = String::from_utf8_lossy(&to.join().unwrap_or_default())
        .trim()
        .to_string();
    // Windows 上 cmd 自己报的错（比如命令不存在）是系统的编码，不是 UTF-8：硬显示出来是一串乱码，换成一句看得懂的
    let err = match String::from_utf8(te.join().unwrap_or_default()) {
        Ok(t) => t.trim().to_string(),
        Err(_) => format!(
            "「{cmdline}」没跑起来，系统给的错误信息显示不出来。多半是命令不存在或者写错了，到「设置」里检查这个 AI 的命令"
        ),
    };
    if !status.success() || out.is_empty() {
        let tail: String = err
            .chars()
            .rev()
            .take(600)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        if let Stats::Codex(f) = &stats {
            let _ = fs::remove_file(f);
        }
        // claude 出错时也会把 JSON 打到标准输出
        if let (Stats::Claude, Some(Err(e))) = (&stats, parse_claude(&out)) {
            return Err(e);
        }
        return Err(if tail.is_empty() {
            format!("「{cmdline}」没有返回内容")
        } else {
            tail
        });
    }
    match stats {
        Stats::Claude => parse_claude(&out).unwrap_or(Ok(Answer {
            text: out,
            usage: None,
        })),
        Stats::Codex(f) => {
            let last = fs::read_to_string(&f)
                .ok()
                .map(|t| t.trim().to_string())
                .filter(|t| !t.is_empty());
            let _ = fs::remove_file(&f);
            let (text, usage) = parse_codex(&out);
            match last.or(text) {
                Some(text) => Ok(Answer { text, usage }),
                None => Err("codex 没有返回回答".into()),
            }
        }
        Stats::None => Ok(Answer {
            text: out,
            usage: None,
        }),
    }
}

#[cfg(test)]
mod ask_tests {
    use super::*;

    #[test]
    fn finds_tools_outside_path() {
        let home = std::env::temp_dir().join(format!("xpanel-tools-{}", now_nanos()));
        let bin = home.join(".local").join("bin");
        fs::create_dir_all(&bin).unwrap();
        fs::write(bin.join("claude.exe"), b"").unwrap();
        fs::create_dir_all(home.join("npm")).unwrap();
        fs::write(home.join("npm").join("codex.cmd"), b"").unwrap();
        let h = home.to_string_lossy().to_string();
        let env = |k: &str| match k {
            "USERPROFILE" | "APPDATA" => Some(h.clone()),
            _ => None,
        };
        let dirs = tool_dirs(&env);
        assert!(dirs.contains(&bin) && dirs.contains(&home.join("npm")));
        let exts = [".exe", ".cmd", ""];
        assert_eq!(
            find_program("claude", &dirs, &exts),
            Some(bin.join("claude.exe"))
        );
        assert_eq!(
            find_program("codex", &dirs, &exts),
            Some(home.join("npm").join("codex.cmd"))
        );
        assert_eq!(find_program("nope", &dirs, &exts), None);
        assert_eq!(program_of("claude -p --output-format json"), "claude");
        assert_eq!(
            program_of("\"C:\\Program Files\\x\\claude.exe\" -p"),
            "C:\\Program Files\\x\\claude.exe"
        );
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn missing_tool_gives_a_clear_error() {
        let e = prepare_path("xpanel-no-such-tool-xyz -p").unwrap_err();
        assert!(e.contains("没找到「xpanel-no-such-tool-xyz」") && e.contains("问答命令"));
        // 带路径的不提前判断，交给系统去跑
        assert!(prepare_path("/no/such/dir/tool -p").is_ok());
    }

    #[test]
    fn infers_commands() {
        let a = |cmd: &str, ask: &str| Agent {
            name: "x".into(),
            cmd: cmd.into(),
            ask: ask.into(),
        };
        assert_eq!(
            ask_command(&a("claude {prompt}", "")).as_deref(),
            Some("claude -p")
        );
        assert_eq!(
            ask_command(&a("C:\\bin\\codex.exe {prompt}", "")).as_deref(),
            Some("codex exec -")
        );
        assert_eq!(ask_command(&a("dsh {prompt}", "")), None);
        assert_eq!(
            ask_command(&a("dsh {prompt}", "dsh --once")).as_deref(),
            Some("dsh --once")
        );
    }

    #[test]
    fn stats_flags_and_parsing() {
        let (c, s) = with_stats("claude -p");
        assert_eq!(c, "claude -p --output-format json");
        assert!(matches!(s, Stats::Claude));
        let (c, s) = with_stats("codex exec -i \"a.png\" -");
        assert!(
            c.starts_with("codex exec -i \"a.png\" --json -o \"") && c.ends_with("\" -"),
            "{c}"
        );
        assert!(matches!(s, Stats::Codex(_)));
        assert!(matches!(with_stats("dsh --once").1, Stats::None));
        let a = parse_claude(r#"{"type":"result","is_error":false,"result":" 好 ","total_cost_usd":0.01,"usage":{"input_tokens":10,"cache_creation_input_tokens":100,"cache_read_input_tokens":1000,"output_tokens":42}}"#)
            .unwrap()
            .unwrap();
        assert_eq!(a.text, "好");
        assert_eq!(
            a.usage.unwrap(),
            Usage {
                input: 1110,
                output: 42,
                cached: 1000,
                cost_usd: Some(0.01)
            }
        );
        assert!(parse_claude(r#"{"is_error":true,"result":"额度用完"}"#)
            .unwrap()
            .is_err());
        let (t, u) = parse_codex(
            "{\"type\":\"thread.started\"}\n{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"答案\"}}\n{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":500,\"cached_input_tokens\":300,\"output_tokens\":20}}",
        );
        assert_eq!(t.as_deref(), Some("答案"));
        assert_eq!(
            u.unwrap(),
            Usage {
                input: 500,
                output: 20,
                cached: 300,
                cost_usd: None
            }
        );
        let (_, u) = parse_codex("{\"msg\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":7,\"output_tokens\":3},\"last_token_usage\":{\"input_tokens\":1,\"output_tokens\":1}}}}");
        assert_eq!(u.unwrap().input, 7);
    }

    #[test]
    fn codex_gets_images_as_flags() {
        let imgs = vec![
            std::path::PathBuf::from("/t/a.png"),
            std::path::PathBuf::from("/t/cv.pdf"),
        ];
        assert_eq!(
            with_images("codex exec -", &imgs),
            "codex exec -i \"/t/a.png\" -"
        );
        assert_eq!(with_images("claude -p", &imgs), "claude -p");
        assert_eq!(with_images("codex exec -", &[]), "codex exec -");
    }

    #[cfg(unix)]
    #[test]
    fn runs_with_stdin() {
        let a = Agent {
            name: "t".into(),
            cmd: String::new(),
            ask: "tr a-z A-Z".into(),
        };
        assert_eq!(ask(&a, "", "hello", &[], 10).unwrap().text, "HELLO");
        let bad = Agent {
            name: "t".into(),
            cmd: String::new(),
            ask: "echo oops >&2; exit 3".into(),
        };
        assert_eq!(ask(&bad, "", "x", &[], 10).unwrap_err(), "oops");
        let slow = Agent {
            name: "t".into(),
            cmd: String::new(),
            ask: "sleep 5".into(),
        };
        assert!(ask(&slow, "", "x", &[], 1).unwrap_err().contains("已停止"));
    }
}
