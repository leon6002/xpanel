/* 正在后台跑的 AI（桌面版叫本机的 Claude Code，或浏览器里叫主机上的）：它每一步在做什么、有没有在等你点允许。
   事件从桌面版来（ai-run，见 src-tauri 的 runs.rs / live.rs）；浏览器里叫主机上的 AI 时从主机的 /api/v1/agents/events 推过来。
   别的 AI 命令行没有这些事件，只有开始和结束。 */
import { create } from "zustand";
import { desk, onAiEvent, remoteAi, type AiEvent } from "./api";
import type { Agent } from "./types";

export interface AiStep {
  /** tool = 在用一个工具，text = 它说的话，error = 这一步没成 */
  kind: "tool" | "text" | "error";
  label: string;
  text: string;
  at: number;
}
export interface AiAsk {
  id: string;
  tool: string;
  /** 做什么，比如「运行命令」 */
  what: string;
  /** 对象：命令、路径、网址 */
  detail: string;
  /** 「以后同类的都允许」里的同类，比如「git log」命令、「读文件」 */
  kind: string;
}
export interface AiRun {
  id: string;
  /** 为哪一条做的 */
  key: string;
  /** 同一条里再细分（评论的哪一串） */
  tag: string;
  agent: string;
  at: number;
  steps: AiStep[];
  ask?: AiAsk;
  stopping?: boolean;
  /** 在主机上跑的（浏览器经主机叫的），确认和停止也发给主机 */
  remote?: boolean;
}

export const useAiRuns = create<{ runs: Record<string, AiRun> }>(() => ({ runs: {} }));
const edit = (id: string, fn: (r: AiRun) => AiRun) =>
  useAiRuns.setState((s) => (s.runs[id] ? { runs: { ...s.runs, [id]: fn(s.runs[id]) } } : s));

function handle(e: AiEvent) {
  if (e.type === "step")
    edit(e.run, (r) => ({ ...r, steps: [...r.steps.slice(-199), { kind: (e.kind as AiStep["kind"]) || "tool", label: e.label || "", text: e.text || "", at: Date.now() }] }));
  else if (e.type === "ask") edit(e.run, (r) => ({ ...r, ask: { id: e.id || "", tool: e.tool || "", what: e.what || "做一件事", detail: e.detail || "", kind: e.kind || "" } }));
  else if (e.type === "asked") edit(e.run, (r) => (r.ask?.id === e.id ? { ...r, ask: undefined } : r));
}
onAiEvent(handle);

/* 主机推过来的进展：有在主机上跑的才连着，先连上再发问，免得漏掉开头几步 */
let es: EventSource | null = null;
let ready: Promise<void> | null = null;
function remoteEvents(): Promise<void> {
  if (es && ready && es.readyState !== EventSource.CLOSED) return ready;
  es?.close();
  const src = new EventSource("/api/v1/agents/events");
  es = src;
  ready = new Promise((res) => {
    const t = setTimeout(res, 2500);
    src.addEventListener("hello", () => (clearTimeout(t), res()));
  });
  src.addEventListener("ai", (m) => {
    try {
      handle(JSON.parse((m as MessageEvent).data));
    } catch {
      /* 不认识的就算了 */
    }
  });
  return ready;
}
function closeRemoteEvents() {
  if (Object.values(useAiRuns.getState().runs).some((r) => r.remote)) return;
  es?.close();
  es = ready = null;
}

let seq = 0;
/** 叫本机的 AI 回答一次，同时登记这一次，界面能看到进展 */
export async function askAi(agent: Agent, cwd: string, prompt: string, images: string[] = [], key = "", tag = "", resume = "") {
  const id = `${Date.now().toString(36)}-${(seq++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const remote = !!agent.remote;
  useAiRuns.setState((s) => ({ runs: { ...s.runs, [id]: { id, key, tag, agent: agent.name, at: Date.now(), steps: [], remote } } }));
  try {
    if (!remote) return await desk.askAi(agent, cwd, prompt, images, key, id, resume);
    await remoteEvents();
    return await remoteAi.ask(agent.name, cwd, prompt, images, key, id, resume);
  } finally {
    useAiRuns.setState((s) => {
      const { [id]: _gone, ...rest } = s.runs;
      return { runs: rest };
    });
    if (remote) closeRemoteEvents();
  }
}

export type AiDecision = "allow" | "kind" | "all" | "deny";
export async function decideAi(run: AiRun, decision: AiDecision) {
  if (!run.ask) return;
  const id = run.ask.id;
  // 先收起来，免得连点两下
  edit(run.id, (r) => (r.ask?.id === id ? { ...r, ask: undefined } : r));
  await (run.remote ? remoteAi.decide(run.id, id, decision) : desk.aiDecide(run.id, id, decision));
}
export async function stopAi(run: AiRun) {
  edit(run.id, (r) => ({ ...r, stopping: true }));
  await (run.remote ? remoteAi.stop(run.id) : desk.aiStop(run.id));
}
