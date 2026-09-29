//! 微信「合并转发 → 导出」ZIP 里的 `聊天记录.txt`。
//!
//! 格式（微信 4.1）：每条消息三部分，条与条之间空一行
//!
//! ```text
//! ·发送人
//! 2026年9月24日 10:31
//! 正文，可以多行
//! [图片] 微信图片_202609241031_1.jpg
//! ```
//!
//! 附件在 ZIP 的 `聊天记录内的图片、视频和文件/` 里，正文只写文件名。
//! TXT 里没有聊天名，也没有消息 id，时间只到分钟。

use chrono::NaiveDateTime;
use serde_json::Value;

/// 一条消息（时间是导出时的本地时间，格式 `YYYY-MM-DD HH:MM`）
#[derive(Debug, Clone, PartialEq)]
pub struct Record {
    pub sender: String,
    pub time: String,
    pub text: String,
}

fn parse_time(line: &str) -> Option<String> {
    let t = NaiveDateTime::parse_from_str(line.trim(), "%Y年%m月%d日 %H:%M").ok()?;
    Some(t.format("%Y-%m-%d %H:%M").to_string())
}

/// 解析整份 TXT。第一行不是消息开头（格式认不出来）时返回 None。
pub fn parse_transcript(body: &str) -> Option<Vec<Record>> {
    let body = body.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    let lines: Vec<&str> = body.split('\n').collect();
    let header = |i: usize| -> Option<(String, String)> {
        let s = lines.get(i)?.strip_prefix('·')?;
        let t = parse_time(lines.get(i + 1)?)?;
        let s = s.trim();
        (!s.is_empty()).then(|| (s.to_string(), t))
    };
    header(0)?;
    let mut out: Vec<Record> = vec![];
    let mut cur: Option<(String, String, Vec<&str>)> = None;
    let mut i = 0;
    while i < lines.len() {
        // 新消息只从空行之后（或文件开头）开始，避免把正文里的「·xx」误当成发送人
        let at_boundary = i == 0 || lines[i - 1].trim().is_empty();
        if at_boundary {
            if let Some((s, t)) = header(i) {
                if let Some((s0, t0, body)) = cur.take() {
                    out.push(record(s0, t0, &body));
                }
                cur = Some((s, t, vec![]));
                i += 2;
                continue;
            }
        }
        if let Some((_, _, body)) = cur.as_mut() {
            body.push(lines[i]);
        }
        i += 1;
    }
    if let Some((s, t, body)) = cur {
        out.push(record(s, t, &body));
    }
    Some(out)
}

fn record(sender: String, time: String, body: &[&str]) -> Record {
    let text = body.join("\n");
    Record {
        sender,
        time,
        text: text.trim_matches('\n').trim_end().to_string(),
    }
}

/// 附件类型：图片、视频、其他文件（语音、表情、文件都算 file）
pub fn kind_of_marker(marker: &str) -> Option<&'static str> {
    let m = marker.to_lowercase();
    Some(match m.as_str() {
        "图片" | "圖片" | "photo" | "image" => "image",
        "视频" | "小视频" | "影片" | "微影片" | "video" => "video",
        "文件" | "檔案" | "file" | "语音" | "語音" | "录音" | "錄音" | "音频" | "音訊"
        | "voice" | "audio" | "recording" | "表情" | "动画表情" | "動態貼圖" | "sticker" => {
            "file"
        }
        _ => return None,
    })
}

pub fn kind_of_name(name: &str) -> &'static str {
    match name
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp" | "avif" | "heic" => "image",
        "mp4" | "m4v" | "mov" | "webm" | "ogv" => "video",
        _ => "file",
    }
}

/// 一行是不是在引用附件：`[图片] 文件名`。返回 (标记给的类型, 文件名)。
pub fn attachment_ref(line: &str) -> Option<(&'static str, &str)> {
    let t = line.trim();
    let rest = t.strip_prefix('[')?;
    let close = rest.find(']')?;
    let kind = kind_of_marker(&rest[..close])?;
    let name = rest[close + 1..].trim();
    (!name.is_empty() && !name.contains('/') && !name.contains('\\')).then_some((kind, name))
}

/// 用来去重的正文：附件行换成附件内容的指纹（同一张图两次导出文件名会变，内容不变）
pub fn normalized_text(text: &str, content_key: impl Fn(&str) -> Option<String>) -> String {
    text.split('\n')
        .map(|l| match attachment_ref(l) {
            Some((k, name)) => match content_key(name) {
                Some(key) => format!("[{k}] {key}"),
                None => l.trim().to_string(),
            },
            None => l.to_string(),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// 聊天里出现最多的几个人，用来给没起名的聊天建议一个名字
pub fn suggest_chat_name(records: &[Record], me: &[String]) -> String {
    let mut counts: Vec<(String, usize)> = vec![];
    for r in records {
        if me.iter().any(|m| m == &r.sender) {
            continue;
        }
        match counts.iter_mut().find(|c| c.0 == r.sender) {
            Some(c) => c.1 += 1,
            None => counts.push((r.sender.clone(), 1)),
        }
    }
    counts.sort_by_key(|c| std::cmp::Reverse(c.1));
    let names: Vec<String> = counts.into_iter().take(3).map(|c| c.0).collect();
    if names.is_empty() {
        "微信聊天".into()
    } else {
        names.join("、")
    }
}

// ---------------------------------------------------------------- Markdown

/// 正文是数据：只转义会改变 Markdown 结构的东西（行首的标题、引用、列表、分隔线，HTML、链接），
/// 普通文字和网址保持原样。
pub fn escape_md_line(line: &str) -> String {
    let mut text = line
        .replace('\\', "\\\\")
        .replace('<', "\\<")
        .replace('[', "\\[")
        .replace('`', "\\`");
    let trimmed = text.trim_start_matches([' ', '\t']);
    let indent = text.len() - trimmed.len();
    let Some(first) = trimmed.chars().next() else {
        return text;
    };
    let rest = &trimmed[first.len_utf8()..];
    let is_rule = trimmed.chars().count() >= 3
        && "-=*_".contains(first)
        && trimmed.chars().all(|c| c == first || c == ' ');
    let is_marker = "#>".contains(first)
        || ("-+*".contains(first) && (rest.is_empty() || rest.starts_with(' ')));
    let digits = trimmed.chars().take_while(|c| c.is_ascii_digit()).count();
    let is_ordered =
        digits > 0 && matches!(trimmed[digits..].chars().next(), Some('.') | Some(')'));
    if is_ordered {
        text.insert(indent + digits, '\\');
    } else if is_rule || is_marker {
        text.insert(indent, '\\');
    }
    if indent >= 4 {
        text.trim_start_matches([' ', '\t']).to_string()
    } else {
        text
    }
}

fn escape_label(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('[', "\\[")
        .replace(']', "\\]")
}

/// 把消息（接口里的消息 JSON）写成一篇 Markdown：按天分节，附件就地嵌入。
/// `link` 把附件（`{kind,name,asset}`）变成链接地址；返回 None 时只写文件名。
pub fn render_markdown(
    chat: &str,
    messages: &[Value],
    link: impl Fn(&Value) -> Option<String>,
) -> String {
    let mut out = vec![format!("# {}", escape_md_line(chat))];
    if let (Some(a), Some(b)) = (messages.first(), messages.last()) {
        out.push(String::new());
        out.push(format!(
            "> 微信聊天记录 · {} 至 {} · {} 条",
            crate::str_of(a, "time"),
            crate::str_of(b, "time"),
            messages.len()
        ));
    }
    let mut day = String::new();
    for m in messages {
        let time = crate::str_of(m, "time");
        let (d, hm) = time.split_once(' ').unwrap_or((time, ""));
        if d != day {
            day = d.to_string();
            out.push(String::new());
            out.push(format!("## {d}"));
        }
        out.push(String::new());
        out.push(format!(
            "**{}** {hm}",
            escape_md_line(crate::str_of(m, "sender"))
        ));
        out.push(String::new());
        let atts: Vec<&Value> = m
            .get("attachments")
            .and_then(|a| a.as_array())
            .map(|a| a.iter().collect())
            .unwrap_or_default();
        let lines: Vec<String> = crate::str_of(m, "text")
            .split('\n')
            .map(|l| {
                if let Some((_, name)) = attachment_ref(l) {
                    if let Some(a) = atts.iter().find(|a| crate::str_of(a, "name") == name) {
                        if let Some(href) = link(a) {
                            let bang = if crate::str_of(a, "kind") == "image" {
                                "!"
                            } else {
                                ""
                            };
                            return format!("{bang}[{}]({href})", escape_label(name));
                        }
                    }
                }
                escape_md_line(l)
            })
            .collect();
        // 行尾两个空格：让消息自己的换行在渲染后保留
        let n = lines.len();
        for (i, l) in lines.into_iter().enumerate() {
            if i + 1 < n && !l.is_empty() {
                out.push(format!("{l}  "));
            } else {
                out.push(l);
            }
        }
    }
    out.join("\n") + "\n"
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const SAMPLE: &str = "\u{feff}·甲\n2026年9月8日 09:10\n第一行\n第二行\n\n·乙\n2026年9月8日 9:11\n[图片] 微信图片_202609080911_1.jpg\n\n·甲\n2026年9月9日 23:05\n·不是发送人\n2026年9月9日 23:05 也不是时间\n\n";

    #[test]
    fn parses_records() {
        let r = parse_transcript(SAMPLE).unwrap();
        assert_eq!(r.len(), 3);
        assert_eq!(r[0].sender, "甲");
        assert_eq!(r[0].time, "2026-09-08 09:10");
        assert_eq!(r[0].text, "第一行\n第二行");
        assert_eq!(r[1].time, "2026-09-08 09:11");
        assert_eq!(
            attachment_ref(&r[1].text),
            Some(("image", "微信图片_202609080911_1.jpg"))
        );
        assert_eq!(r[2].text, "·不是发送人\n2026年9月9日 23:05 也不是时间");
    }

    #[test]
    fn crlf_and_unknown_format() {
        let r = parse_transcript("·甲\r\n2026年9月8日 09:10\r\nhi\r\n").unwrap();
        assert_eq!(r[0].text, "hi");
        assert!(parse_transcript("新版格式\n内容").is_none());
        assert!(parse_transcript("").is_none());
    }

    #[test]
    fn markers() {
        assert_eq!(attachment_ref("[视频号] x.mp4"), None);
        assert_eq!(attachment_ref("[文件] a/b.pdf"), None);
        assert_eq!(
            attachment_ref(" [File] 报告.pdf "),
            Some(("file", "报告.pdf"))
        );
        assert_eq!(attachment_ref("[图片]"), None);
        assert_eq!(kind_of_name("a.MP4"), "video");
    }

    #[test]
    fn normalizes_attachment_names() {
        let a = normalized_text("看这个\n[图片] 微信图片_1.jpg", |_| {
            Some("sha:ab".into())
        });
        let b = normalized_text("看这个\n[图片] 微信图片_7.jpg", |_| {
            Some("sha:ab".into())
        });
        assert_eq!(a, b);
        assert_eq!(normalized_text("[图片] x.jpg", |_| None), "[图片] x.jpg");
    }

    #[test]
    fn suggests_names() {
        let r = parse_transcript(SAMPLE).unwrap();
        assert_eq!(suggest_chat_name(&r, &[]), "甲、乙");
        assert_eq!(suggest_chat_name(&r, &["甲".into()]), "乙");
    }

    #[test]
    fn escapes() {
        assert_eq!(escape_md_line("# 标题"), "\\# 标题");
        assert_eq!(escape_md_line("1. 一"), "1\\. 一");
        assert_eq!(escape_md_line("- 项"), "\\- 项");
        assert_eq!(escape_md_line("---"), "\\---");
        assert_eq!(escape_md_line("<b>[x](y)"), "\\<b>\\[x](y)");
        assert_eq!(escape_md_line("https://a.b/c?d=1"), "https://a.b/c?d=1");
        assert_eq!(escape_md_line("-1 度"), "-1 度");
    }

    #[test]
    fn markdown() {
        let msgs = vec![
            json!({"sender":"甲","time":"2026-09-08 09:10","text":"一\n二"}),
            json!({"sender":"乙","time":"2026-09-08 09:11","text":"[图片] p.jpg",
                   "attachments":[{"kind":"image","name":"p.jpg","asset":"wx-1.jpg"}]}),
            json!({"sender":"甲","time":"2026-09-09 08:00","text":"[文件] 缺.pdf"}),
        ];
        let md = render_markdown("测试群", &msgs, |a| {
            Some(format!("asset:{}", crate::str_of(a, "asset")))
        });
        assert!(md.contains("## 2026-09-08"));
        assert!(md.contains("## 2026-09-09"));
        assert!(md.contains("**甲** 09:10\n\n一  \n二\n"));
        assert!(md.contains("![p.jpg](asset:wx-1.jpg)"));
        assert!(md.contains("\\[文件] 缺.pdf"));
        assert!(md.contains("3 条"));
    }
}
