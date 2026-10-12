//! 测界面用：开一个带「假 AI」的服务，模拟桌面版当主机、允许局域网叫本机的 AI。
//! cargo run -p xp-server --example fake_host -- <数据文件夹> [端口]
//!
//! 假 AI 收到问题后：走一步「读文件」，再要求确认「运行命令 git status」，
//! 允许了就回答「主机上的 AI 看过了」，拒绝了就回答「没让我运行命令」。

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use xp_server::{AgentHost, AskReq};
use xp_store::Store;

#[derive(Default)]
struct Fake {
    waiting: Mutex<HashMap<String, mpsc::Sender<String>>>,
}

impl AgentHost for Fake {
    fn agents(&self) -> Value {
        json!({"agents": [{"name": "Claude Code"}], "device": {"id": "", "hostname": "fake-host"}})
    }
    fn ask(&self, req: AskReq, emit: Box<dyn Fn(Value) + Send + Sync>) -> Result<Value, String> {
        let run = req.run.clone();
        emit(
            json!({"run": run, "type": "step", "kind": "tool", "label": "读文件", "text": "README.md"}),
        );
        let (tx, rx) = mpsc::channel();
        self.waiting.lock().unwrap().insert(run.clone(), tx);
        emit(
            json!({"run": run, "type": "ask", "id": "0", "tool": "Bash", "what": "运行命令", "detail": "git status", "kind": "「git status」命令"}),
        );
        let answer = rx
            .recv_timeout(std::time::Duration::from_secs(120))
            .unwrap_or_else(|_| "stop".into());
        self.waiting.lock().unwrap().remove(&run);
        emit(json!({"run": run, "type": "asked", "id": "0", "answer": answer}));
        if answer == "stop" {
            return Err("用户停止了这次任务".into());
        }
        emit(json!({"run": run, "type": "end"}));
        let text = if answer == "deny" {
            "没让我运行命令".to_string()
        } else {
            format!(
                "主机上的 AI 看过了（问题 {} 个字）",
                req.prompt.chars().count()
            )
        };
        Ok(json!({ "text": text }))
    }
    fn decide(&self, run: &str, _id: &str, decision: &str) -> Result<(), String> {
        let tx = self
            .waiting
            .lock()
            .unwrap()
            .remove(run)
            .ok_or("这个请求已经回答过了")?;
        tx.send(decision.to_string()).map_err(|e| e.to_string())
    }
    fn stop(&self, run: &str) {
        if let Some(tx) = self.waiting.lock().unwrap().remove(run) {
            let _ = tx.send("stop".into());
        }
    }
}

fn main() {
    let mut a = std::env::args().skip(1);
    let dir = a.next().expect("数据文件夹");
    let port: u16 = a.next().and_then(|p| p.parse().ok()).unwrap_or(18767);
    let st = Arc::new(Store::open(&dir).expect("打开数据"));
    let l = xp_server::bind(port).expect("端口");
    let rt = tokio::runtime::Runtime::new().unwrap();
    println!("假主机：http://0.0.0.0:{port}/");
    rt.block_on(xp_server::serve_with(
        st,
        l,
        Some(Arc::new(Fake::default())),
        async {
            let _ = tokio::signal::ctrl_c().await;
        },
    ))
    .unwrap();
}
