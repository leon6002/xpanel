/* 传输层：界面只认这里的函数。
   桌面版走 Tauri 命令（主机模式在本进程处理，连接模式由桌面版转发，离线时有队列）；浏览器走 HTTP。 */
import type { Agent, AppConfig, BackupResult, Config, DriveStatus, Item, MergeChoice, MergePreview, MergeResult, State, Template, Usage } from "./types";

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
const tauri = (window as unknown as { __TAURI__?: { core?: { invoke: Invoke } } }).__TAURI__;
export const invoke: Invoke | null = tauri?.core?.invoke ?? null;
export const isApp = !!invoke;

/** 桌面版发来的：后台的 AI 走了一步（step）、要你点头（ask）、有人答复了（asked）、结束了（end） */
export interface AiEvent {
  run: string;
  type: "step" | "ask" | "asked" | "end";
  kind?: string;
  label?: string;
  text?: string;
  id?: string;
  tool?: string;
  what?: string;
  detail?: string;
}
export function onAiEvent(cb: (e: AiEvent) => void) {
  const ev = (window as unknown as { __TAURI__?: { event?: { listen?: (name: string, fn: (e: { payload: AiEvent }) => void) => Promise<unknown> } } }).__TAURI__?.event;
  ev?.listen?.("ai-run", (e) => cb(e.payload))?.catch?.(() => {});
}

/** 主机要令牌而这个浏览器还没登录：通知界面换成输入令牌的页面（见 components/TokenGate.tsx） */
export const NEED_TOKEN = "xp-need-token";
const needToken = (r: Response, body: unknown) => {
  if (r.status === 401 && (body as { needToken?: boolean })?.needToken) window.dispatchEvent(new Event(NEED_TOKEN));
};

async function http<T>(url: string, init?: RequestInit): Promise<T> {
  let r: Response;
  try {
    r = await fetch(url, init);
  } catch {
    throw new Error("连不上工作台主机");
  }
  const text = await r.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* 纯文本（比如 Markdown 导出） */
  }
  if (!r.ok) {
    needToken(r, body);
    throw new Error((body as { error?: string })?.error || `请求失败 ${r.status}`);
  }
  return body as T;
}

/* ---- 局域网令牌（浏览器）：登录后主机种一个 cookie，之后的请求、图片、推送都自动带上 ---- */
export interface AuthStatus { requireToken: boolean; remoteAi: boolean; local: boolean; ok: boolean; name?: string | null }
export const auth = {
  status: () => http<AuthStatus>("/api/v1/auth/status"),
  login: (token: string) => http<{ ok: boolean; name: string }>("/api/v1/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: token.trim() }) }),
  logout: () => http<{ ok: boolean }>("/api/v1/auth/logout", { method: "POST" }),
};

/* ---- 主机上的局域网权限和令牌（只有主机本机能改：桌面版主机模式、或主机上的浏览器） ---- */
export interface AccessInfo { access: { requireToken: boolean; remoteAi: boolean }; tokens: { name: string; createdAt: number; lastUsed?: number | null }[] }
export const access = {
  get: () => v1<AccessInfo>("GET", "/access"),
  set: (a: { requireToken: boolean; remoteAi: boolean }) => v1<{ access: AccessInfo["access"] }>("PUT", "/access", a),
  create: (name: string) => v1<{ name: string; token: string }>("POST", "/access/tokens", { name }),
  remove: (name: string) => v1<{ access: AccessInfo["access"] }>("DELETE", "/access/tokens/" + encodeURIComponent(name)),
};

/* ---- 浏览器里叫主机上的 AI（主机打开了「允许局域网叫本机的 AI」）；进展从 /api/v1/agents/events 推过来，见 lib/aiRuns.ts ---- */
export interface RemoteAgents { enabled: boolean; reason?: string; agents: { name: string }[]; device?: { id: string; hostname: string } | null }
export const remoteAi = {
  list: () => v1<RemoteAgents>("GET", "/agents"),
  ask: (agent: string, cwd: string, prompt: string, images: string[], key: string, run: string, resume: string) =>
    v1<{ text: string; usage?: Usage; session?: string }>("POST", "/agents/ask", { agent, cwd, prompt, images, key, run, resume: resume || null }),
  decide: (run: string, id: string, decision: string) => v1("POST", `/agents/runs/${encodeURIComponent(run)}/decide`, { id, decision }),
  stop: (run: string) => v1("POST", `/agents/runs/${encodeURIComponent(run)}/stop`),
};

/** /api/v1 接口 */
export async function v1<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  if (invoke) {
    const r = await invoke<{ status: number; body: unknown }>("api_call", { method, path, body: body ?? null });
    if (r.status >= 400) throw new Error((r.body as { error?: string })?.error || `请求失败 ${r.status}`);
    return r.body as T;
  }
  return http<T>("/api/v1" + path, {
    method,
    headers: { "Content-Type": "application/json", "X-Actor": "ui" },
    body: body == null ? undefined : JSON.stringify(body),
  });
}

/** 全部条目、设备、分类（桌面版连接模式离线时返回缓存） */
export function getState(): Promise<State> {
  return invoke ? invoke<State>("get_state") : http<State>("/api/state");
}

export function getRev(): Promise<string | number> {
  return invoke ? invoke<string | number>("get_rev") : http<{ rev: string }>("/api/rev").then((r) => r.rev);
}

/** 写条目：走 v1 操作（桌面版连接模式断网时进离线队列，恢复后补传） */
export type Op =
  | { kind: "upsert"; item: Item }
  | { kind: "delete"; id: string }
  | { kind: "import"; items: Item[] }
  /** 只改几个字段；expect 里的字段在主机上对不上就是冲突（别处刚改过） */
  | { kind: "patch"; id: string; set: Record<string, unknown>; unset?: string[]; expect?: Record<string, unknown> };
export function applyOp(op: Op): Promise<State> {
  if (invoke) return invoke<State>("apply_op", { op });
  return http<State>("/api/op", { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(op) });
}

const assetCache = new Map<string, Promise<string>>();
/** 附件地址：浏览器直接用接口地址，桌面版换成 data: 网址 */
export function assetSrc(name: string): Promise<string> {
  if (!invoke) return Promise.resolve("/api/asset/" + encodeURIComponent(name));
  let p = assetCache.get(name);
  if (!p) {
    p = invoke<string>("get_asset", { name }).catch((e) => {
      assetCache.delete(name);
      throw e;
    });
    assetCache.set(name, p);
  }
  return p;
}

export async function putAsset(file: File): Promise<string> {
  if (file.size > 25 * 1024 * 1024) throw new Error("文件超过 25MB，建议放共享文件夹后在笔记里写路径");
  const ext = ((file.name.match(/\.([a-z0-9]{1,8})$/i) || [, file.type.split("/")[1] || "bin"])[1] || "bin").toLowerCase().replace(/[^a-z0-9]/g, "");
  const name = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}.${ext || "bin"}`;
  const data = await new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1] ?? "");
    r.onerror = () => rej(new Error("读取文件失败"));
    r.readAsDataURL(file);
  });
  if (invoke) return invoke<string>("put_asset", { name, data });
  const j = await http<{ name: string }>("/api/asset", { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ name, data }) });
  return j.name;
}

/** 打开网址、本地路径（桌面版）；浏览器里网址开新标签，其他复制 */
export async function openTarget(t: string): Promise<"opened" | "copied"> {
  if (invoke) {
    await invoke("open_target", { target: t });
    return "opened";
  }
  if (/^https?:\/\//i.test(t)) {
    window.open(t, "_blank", "noopener");
    return "opened";
  }
  // 局域网里用 http 打开的页面没有 navigator.clipboard，copyText 里有退路
  if (!(await copyText(t))) throw new Error("网页版不能直接打开本地路径，复制也没成");
  return "copied";
}

export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/** /api/v1 里返回纯文本的接口（比如聊天导出的 Markdown） */
export async function v1Text(path: string): Promise<string> {
  if (invoke) {
    const r = await invoke<{ status: number; body: unknown }>("api_call", { method: "GET", path, body: null });
    if (r.status >= 400) throw new Error((r.body as { error?: string })?.error || "读取失败");
    return typeof r.body === "string" ? r.body : JSON.stringify(r.body);
  }
  const r = await fetch("/api/v1" + path, { headers: { "X-Actor": "ui" } });
  if (!r.ok) {
    needToken(r, await r.clone().json().catch(() => null));
    throw new Error("读取失败 " + r.status);
  }
  return r.text();
}

/** 把一条的内容从主机上彻底抹掉（转入密码库之后用），只留删除标记 */
export const scrubItem = (id: string) => v1("POST", `/items/${encodeURIComponent(id)}/scrub`);

export const errText = (e: unknown) => (e instanceof Error ? e.message : typeof e === "string" ? e : String(e));

export async function copyText(v: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(v);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = v;
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      /* 没办法了 */
    }
    ta.remove();
    return ok;
  }
}

export function fileB64(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1] ?? "");
    r.onerror = () => rej(new Error("读取文件失败"));
    r.readAsDataURL(file);
  });
}

/* ---- 外置硬盘同步：备份到外置硬盘、从外置硬盘按条目合并（桌面版和浏览器都能用） ---- */
export const drive = {
  status: () => v1<DriveStatus>("GET", "/backup"),
  /** 外置硬盘上有别的电脑的新备份时不备份，返回 needsMerge；force 照样备份 */
  backup: (force = false) => v1<BackupResult>("POST", "/backup", { force }),
  preview: () => v1<MergePreview>("GET", "/backup/merge"),
  /** file 是预览里 latest.file；没列在 choices 里的保留本机的 */
  merge: (file: string, choices: Record<string, MergeChoice>) => v1<MergeResult>("POST", "/backup/merge", { file, choices }),
};

/* ---- 只有桌面版有的命令 ---- */
function need(): NonNullable<typeof invoke> {
  if (!invoke) throw new Error("只有桌面版能用");
  return invoke;
}
export const desk = {
  getConfig: () => need()<AppConfig>("get_config"),
  saveConfig: (cfg: Partial<Config>) => need()<{ config: Config; lan: AppConfig["lan"]; lanError?: string }>("save_config", { cfg }),
  setThisDevice: (id: string) => need()<{ config: Config }>("set_this_device", { id }),
  openDataDir: () => need()<void>("open_data_dir"),
  createShortcut: () => need()<string>("create_desktop_shortcut"),
  runAgent: (agent: Agent, cwd: string, prompt: string) => need()<void>("run_agent", { agent, cwd, prompt }),
  /** 设置外置硬盘上的文件夹（只有主机的桌面版能改） */
  setSyncDir: (dir: string) => need()<{ config: Config }>("set_sync_dir", { dir }),
  /** run：这一次的编号。给了的话桌面版边跑边发 ai-run 事件（进展、要确认的事），见 lib/aiRuns.ts */
  /** resume：接着 claude 的哪一次对话说（上一次返回的 session） */
  askAi: async (agent: Agent, cwd: string, prompt: string, images: string[] = [], key = "", run = "", resume = "") => {
    // 新版返回 {text, usage, session}；兼容只返回文字的旧版
    const r = await need()<string | { text: string; usage?: Usage; session?: string }>("ask_ai", { agent, cwd, prompt, images, key, run, resume: resume || null });
    return typeof r === "string" ? { text: r } : r;
  },
  aiDecide: (run: string, id: string, decision: string) => need()<void>("ai_decide", { run, id, decision }),
  aiStop: (run: string) => need()<void>("ai_stop", { run }),
  wsDefaults: (title: string, itemId: string, root: string | null) =>
    need()<{ root: string; name: string; path: string; defaultRoot: string }>("workspace_defaults", { title, itemId, root }),
  wsCheck: (root: string, name: string, itemId: string) => need()<{ path: string; state: "new" | "ours" | "other" | "busy" }>("workspace_check", { root, name, itemId }),
  wsPrepare: (item: Item, root: string, name: string, template: Template, git: boolean) =>
    need()<{ path: string; summary: string }>("workspace_prepare", { item, root, name, template, git }),
  wsSync: (item: Item, path: string, force: boolean) => need()<{ skipped?: boolean; empty?: boolean; summary?: string }>("workspace_sync", { item, path, force }),
  wsHandoff: (path: string, record: boolean) => need()<{ prompt: string; summary: string; first: boolean; empty: boolean }>("workspace_handoff", { path, record }),
};

/** 桌面版的窗口标题栏跟着界面换深浅色 */
export function setWindowTheme(t: "light" | "dark" | null) {
  try {
    const w = (window as unknown as { __TAURI__?: { window?: { getCurrentWindow?: () => { setTheme?: (t: string | null) => Promise<void> } } } }).__TAURI__?.window?.getCurrentWindow?.();
    w?.setTheme?.(t)?.catch(() => {});
  } catch {
    /* 浏览器里没有 */
  }
}
