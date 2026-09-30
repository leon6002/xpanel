/* 传输层：界面只认这里的函数。
   桌面版走 Tauri 命令（主机模式在本进程处理，连接模式由桌面版转发，离线时有队列）；浏览器走 HTTP。 */
import type { Agent, AppConfig, Config, Item, State, Template, Usage } from "./types";

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
const tauri = (window as unknown as { __TAURI__?: { core?: { invoke: Invoke } } }).__TAURI__;
export const invoke: Invoke | null = tauri?.core?.invoke ?? null;
export const isApp = !!invoke;

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
  if (!r.ok) throw new Error((body as { error?: string })?.error || `请求失败 ${r.status}`);
  return body as T;
}

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
  await navigator.clipboard.writeText(t);
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
  if (!r.ok) throw new Error("读取失败 " + r.status);
  return r.text();
}

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
  askAi: async (agent: Agent, cwd: string, prompt: string, images: string[] = [], key = "") => {
    // 新版返回 {text, usage}；兼容只返回文字的旧版
    const r = await need()<string | { text: string; usage?: Usage }>("ask_ai", { agent, cwd, prompt, images, key });
    return typeof r === "string" ? { text: r } : r;
  },
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
