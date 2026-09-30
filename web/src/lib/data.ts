/* 数据层：全部条目一次取回（和旧界面一样，几千条也很快），变化时整体刷新；写入先改本地再提交 */
import { QueryClient, useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { applyOp, desk, getRev, getState, isApp, newId, v1 } from "./api";
import type { AppConfig, Chat, Device, Item, State, Template } from "./types";
import { useUi } from "./store";

export const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, refetchOnWindowFocus: false, retry: 1 } } });

/** 桌面版：配置还没选好（第一次打开）时不去取数据 */
export function useAppState() {
  const cfg = useConfig();
  const ready = !isApp || !!cfg.data?.config.mode;
  return useQuery({ queryKey: ["state"], queryFn: getState, enabled: ready, refetchInterval: false });
}

/** 桌面版的配置（浏览器里没有） */
export function useConfig() {
  return useQuery({ queryKey: ["config"], queryFn: desk.getConfig, enabled: isApp, staleTime: Infinity });
}
export const setConfig = (c: Partial<AppConfig>) => qc.setQueryData<AppConfig>(["config"], (old) => (old ? { ...old, ...c } : (c as AppConfig)));
export function useDevices(): Device[] {
  return useAppState().data?.devices ?? [];
}
/** 这台电脑在设备表里的 id（浏览器里为空） */
export function useThisDevice() {
  const c = useConfig().data;
  return { id: c?.config.deviceId || "", hostname: c?.hostname || "" };
}

export function useChats() {
  const st = useAppState();
  return useQuery({
    queryKey: ["chats"],
    queryFn: () => v1<{ chats: Chat[] }>("GET", "/inbox/chats").then((r) => r.chats || []),
    enabled: st.isSuccess,
  });
}
export function useMe() {
  const st = useAppState();
  return useQuery({ queryKey: ["me"], queryFn: () => v1<{ me: string[] }>("GET", "/inbox/me").then((r) => r.me || []), enabled: st.isSuccess });
}
export function useTemplates() {
  return useQuery({ queryKey: ["templates"], queryFn: () => v1<{ templates: Template[] }>("GET", "/templates").then((r) => r.templates || []) });
}
export const useItems = () => useAppState().data?.items ?? [];

/** 数据变了就刷新：浏览器用 SSE，桌面版每 3 秒问一次版本号 */
export function useLiveUpdates(enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    let last: string | number | undefined;
    const check = async () => {
      if (document.hidden) return;
      try {
        const r = await getRev();
        const st = qc.getQueryState(["state"]);
        if ((last !== undefined && r !== last) || st?.status === "error") qc.invalidateQueries();
        last = r;
      } catch {
        /* 离线：等下一次 */
      }
    };
    check();
    if (!isApp && "EventSource" in window) {
      const es = new EventSource("/api/v1/events");
      es.addEventListener("change", () => qc.invalidateQueries());
      const t = window.setInterval(check, 30000);
      return () => {
        es.close();
        window.clearInterval(t);
      };
    }
    const t = window.setInterval(check, 3000);
    const vis = () => !document.hidden && check();
    document.addEventListener("visibilitychange", vis);
    return () => {
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", vis);
    };
  }, [enabled]);
}

/* 改动按顺序一个个发给主机：同时发两个时后发的可能先到，旧内容会盖掉新内容。
   还有改动排着队时不拿主机返回的状态覆盖本地（那份状态还没包含后面的改动）。 */
let queue: Promise<unknown> = Promise.resolve();
let inflight = 0;
async function commit(op: Parameters<typeof applyOp>[0], optimistic: (s: State) => State) {
  const prev = qc.getQueryData<State>(["state"]);
  if (prev) qc.setQueryData(["state"], optimistic(prev));
  inflight++;
  const run = queue.then(() => applyOp(op));
  queue = run.catch(() => {});
  try {
    const next = await run;
    if (inflight === 1) qc.setQueryData(["state"], next);
  } catch (e) {
    useUi.getState().say("保存失败：" + (e instanceof Error ? e.message : String(e)));
    qc.invalidateQueries({ queryKey: ["state"] });
    throw e;
  } finally {
    inflight--;
  }
}

export function saveItem(item: Item) {
  return commit({ kind: "upsert", item }, (s) => {
    const i = s.items.findIndex((x) => x.id === item.id);
    const items = s.items.slice();
    if (i >= 0) items[i] = item;
    else items.push(item);
    return { ...s, items };
  });
}

/** 改一条的几个字段：只把改的字段发给主机，在主机的最新内容上合并（本机缓存旧了也不会把别处的改动盖掉）。
 *  expect：这些字段在主机上应该还是这个值，对不上就拒绝（冲突），见编辑器的冲突处理 */
export function patchItem(it: Item, ch: Partial<Item>, opts: { expect?: Partial<Item> } = {}) {
  const cur = qc.getQueryData<State>(["state"])?.items.find((x) => x.id === it.id) ?? it;
  const now = Date.now();
  const set: Record<string, unknown> = { updatedAt: now };
  const unset: string[] = [];
  for (const [k, v] of Object.entries(ch)) {
    if (k === "id") continue;
    if (v === undefined) unset.push(k);
    else set[k] = v;
  }
  // 勾选完成时记下完成时间
  if (ch.done === true && !cur.done) set.doneAt = now;
  if (ch.done === false) unset.push("doneAt");
  const next = { ...cur, ...set } as Item;
  for (const k of unset) delete (next as Record<string, unknown>)[k];
  return commit({ kind: "patch", id: cur.id, set, unset, ...(opts.expect ? { expect: opts.expect as Record<string, unknown> } : {}) }, (s) => ({
    ...s,
    items: s.items.map((x) => (x.id === cur.id ? next : x)),
  }));
}

export async function addItem(p: Partial<Item> & { type: Item["type"]; title: string }) {
  const now = Date.now();
  const item: Item = { tags: [], device: "", done: false, pinned: false, body: "", ...p, id: newId(), createdAt: now, updatedAt: now };
  await saveItem(item);
  return item;
}

export function removeItem(id: string) {
  // 子笔记往上挪一层（主机那边也是这么处理的）
  return commit({ kind: "delete", id }, (s) => {
    const up = s.items.find((x) => x.id === id)?.parentId as string | undefined;
    return {
      ...s,
      items: s.items
        .filter((x) => x.id !== id)
        .map((x) => {
          if (x.parentId !== id) return x;
          const { parentId: _drop, ...rest } = x;
          void _drop;
          return (up ? { ...rest, parentId: up } : rest) as Item;
        }),
    };
  });
}

export async function importItems(items: Item[]) {
  const next = await applyOp({ kind: "import", items });
  qc.setQueryData(["state"], next);
}

/** 删除后可以撤销：原样写回 */
export function restoreItem(it: Item) {
  return saveItem({ ...it, updatedAt: Date.now() });
}
