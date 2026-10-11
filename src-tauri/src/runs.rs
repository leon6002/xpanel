//! 正在后台跑的 AI（一次问答一个）：把进展报给界面，把「要不要允许」交给用户回答，记住这一次里已经放行的种类，能中途停止。
//! 确认只在这台电脑的桌面版里做，不经过主机的接口：局域网里别的电脑不能替你点允许。

use crate::live::{covered, describe, kind_of, Watch};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, LazyLock, Mutex};
use std::time::Duration;

type Emit = Box<dyn Fn(Value) + Send + Sync>;

pub struct Run {
    id: String,
    emit: Emit,
    stop: AtomicBool,
    /// 用户点了「这次任务都允许」
    all: AtomicBool,
    /// 用户点过「同类的都允许」的种类
    kinds: Mutex<HashSet<String>>,
    /// 正等用户回答的请求
    waiting: Mutex<HashMap<String, mpsc::Sender<String>>>,
    seq: AtomicU64,
}

static RUNS: LazyLock<Mutex<HashMap<String, Arc<Run>>>> = LazyLock::new(Default::default);

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn start(id: &str, emit: Emit) -> Arc<Run> {
    let run = Arc::new(Run {
        id: id.to_string(),
        emit,
        stop: AtomicBool::new(false),
        all: AtomicBool::new(false),
        kinds: Mutex::new(HashSet::new()),
        waiting: Mutex::new(HashMap::new()),
        seq: AtomicU64::new(0),
    });
    lock(&RUNS).insert(id.to_string(), run.clone());
    run
}

pub fn finish(id: &str) {
    if let Some(r) = lock(&RUNS).remove(id) {
        (r.emit)(json!({"run": id, "type": "end"}));
    }
}

/// 用户的回答：allow（这一次）、kind（以后同类的都允许）、all（这次任务都允许）、deny
pub fn decide(run: &str, id: &str, decision: &str) -> Result<(), String> {
    if !["allow", "kind", "all", "deny"].contains(&decision) {
        return Err("不认识的回答".into());
    }
    let r = lock(&RUNS).get(run).cloned().ok_or("这次任务已经结束了")?;
    let tx = lock(&r.waiting).remove(id).ok_or("这个请求已经回答过了")?;
    tx.send(decision.to_string())
        .map_err(|_| "这个请求已经作废了".to_string())
}

pub fn stop(run: &str) {
    if let Some(r) = lock(&RUNS).get(run) {
        r.stop.store(true, Ordering::SeqCst);
    }
}

impl Watch for Run {
    fn step(&self, kind: &str, label: &str, text: &str) {
        (self.emit)(
            json!({"run": self.id, "type": "step", "kind": kind, "label": label, "text": text}),
        );
    }

    fn permit(&self, tool: &str, input: &Value) -> Result<(), String> {
        if self.all.load(Ordering::SeqCst) || covered(&lock(&self.kinds), tool, input) {
            return Ok(());
        }
        let id = self.seq.fetch_add(1, Ordering::SeqCst).to_string();
        let (tx, rx) = mpsc::channel();
        lock(&self.waiting).insert(id.clone(), tx);
        let (what, detail) = describe(tool, input);
        let (key, kind) = kind_of(tool, input);
        (self.emit)(
            json!({"run": self.id, "type": "ask", "id": id, "tool": tool, "what": what, "detail": detail, "kind": kind}),
        );
        let answer = loop {
            if self.stopped() {
                break "stop".to_string();
            }
            match rx.recv_timeout(Duration::from_millis(200)) {
                Ok(a) => break a,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break "deny".to_string(),
            }
        };
        lock(&self.waiting).remove(&id);
        (self.emit)(json!({"run": self.id, "type": "asked", "id": id, "answer": answer}));
        match answer.as_str() {
            "allow" => Ok(()),
            "kind" => {
                lock(&self.kinds).insert(key);
                Ok(())
            }
            "all" => {
                self.all.store(true, Ordering::SeqCst);
                Ok(())
            }
            "stop" => Err("用户停止了这次任务".into()),
            _ => Err("用户没有同意这一步。换个不需要它的办法，或者跳过并在最后说明".into()),
        }
    }

    fn stopped(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(id: &str) -> (Arc<Run>, Arc<Mutex<Vec<Value>>>) {
        let seen = Arc::new(Mutex::new(vec![]));
        let s = seen.clone();
        (
            start(id, Box::new(move |v| s.lock().unwrap().push(v))),
            seen,
        )
    }

    /// 等请求发出来，再替用户回答
    fn answer(
        id: &'static str,
        seen: Arc<Mutex<Vec<Value>>>,
        with: &'static str,
    ) -> std::thread::JoinHandle<()> {
        std::thread::spawn(move || loop {
            let asks = seen
                .lock()
                .unwrap()
                .iter()
                .filter(|v| v["type"] == "ask")
                .count();
            let ask = seen
                .lock()
                .unwrap()
                .iter()
                .filter(|v| v["type"] == "ask")
                .nth(asks.saturating_sub(1))
                .cloned();
            if let Some(a) = ask {
                if decide(id, a["id"].as_str().unwrap(), with).is_ok() {
                    return;
                }
            }
            std::thread::sleep(Duration::from_millis(20));
        })
    }

    #[test]
    fn asks_once_per_kind_and_remembers() {
        let (r, seen) = run("t-kind");
        let log = json!({"command": "git log -1"});
        let t = answer("t-kind", seen.clone(), "kind");
        assert!(r.permit("Bash", &log).is_ok());
        t.join().unwrap();
        // 同类的不再问；别的命令还要问
        assert!(r
            .permit("Bash", &json!({"command": "git log --stat"}))
            .is_ok());
        let t = answer("t-kind", seen.clone(), "deny");
        assert!(r.permit("Bash", &json!({"command": "git push"})).is_err());
        t.join().unwrap();
        let asks: Vec<Value> = seen
            .lock()
            .unwrap()
            .iter()
            .filter(|v| v["type"] == "ask")
            .cloned()
            .collect();
        assert_eq!(asks.len(), 2);
        assert_eq!(asks[0]["what"], "运行命令");
        assert_eq!(asks[0]["detail"], "git log -1");
        assert_eq!(asks[0]["kind"], "「git log」命令");
        finish("t-kind");
        assert_eq!(seen.lock().unwrap().last().unwrap()["type"], "end");
        assert!(decide("t-kind", "0", "allow").is_err());
    }

    #[test]
    fn allow_all_and_stop() {
        let (r, seen) = run("t-all");
        let t = answer("t-all", seen.clone(), "all");
        assert!(r.permit("Read", &json!({"file_path": "/x"})).is_ok());
        t.join().unwrap();
        assert!(r
            .permit("Bash", &json!({"command": "anything | at all"}))
            .is_ok());
        finish("t-all");

        let (r, _) = run("t-stop");
        let r2 = r.clone();
        let t = std::thread::spawn(move || r2.permit("Write", &json!({"file_path": "/x"})));
        std::thread::sleep(Duration::from_millis(100));
        stop("t-stop");
        assert!(t.join().unwrap().is_err());
        assert!(r.stopped());
        finish("t-stop");
    }
}
