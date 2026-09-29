/* 传输层：界面只认这里的函数。
   桌面版走 Tauri 命令（主机模式在本进程处理，连接模式由桌面版转发，离线时有队列）；浏览器走 HTTP。 */
import type { Item, State } from "./types";

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
export function applyOp(op: { kind: "upsert"; item: Item } | { kind: "delete"; id: string }): Promise<State> {
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
