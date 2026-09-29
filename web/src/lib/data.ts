/* 数据层：全部条目一次取回（和旧界面一样，几千条也很快），变化时整体刷新；写入先改本地再提交 */
import { QueryClient, useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { applyOp, getRev, getState, isApp, newId } from "./api";
import type { Item, State } from "./types";
import { useUi } from "./store";

export const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, refetchOnWindowFocus: false, retry: 1 } } });

export function useAppState() {
  return useQuery({ queryKey: ["state"], queryFn: getState });
}
export const useItems = () => useAppState().data?.items ?? [];

/** 数据变了就刷新：浏览器用 SSE，桌面版每 3 秒问一次版本号 */
export function useLiveUpdates() {
  useEffect(() => {
    let last: string | number | undefined;
    const check = async () => {
      if (document.hidden) return;
      try {
        const r = await getRev();
        if (last !== undefined && r !== last) {
          qc.invalidateQueries();
        }
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
  }, []);
}

async function commit(op: Parameters<typeof applyOp>[0], optimistic: (s: State) => State) {
  const prev = qc.getQueryData<State>(["state"]);
  if (prev) qc.setQueryData(["state"], optimistic(prev));
  try {
    const next = await applyOp(op);
    qc.setQueryData(["state"], next);
  } catch (e) {
    useUi.getState().say("保存失败：" + (e instanceof Error ? e.message : String(e)));
    qc.invalidateQueries({ queryKey: ["state"] });
    throw e;
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

export function patchItem(it: Item, ch: Partial<Item>) {
  const cur = qc.getQueryData<State>(["state"])?.items.find((x) => x.id === it.id) ?? it;
  const next: Item = { ...cur, ...ch, updatedAt: Date.now() };
  // 勾选完成时记下完成时间
  if (ch.done === true && !cur.done) next.doneAt = Date.now();
  if (ch.done === false) delete next.doneAt;
  return saveItem(next);
}

export async function addItem(p: Partial<Item> & { type: Item["type"]; title: string }) {
  const now = Date.now();
  const item: Item = { tags: [], device: "", done: false, pinned: false, body: "", ...p, id: newId(), createdAt: now, updatedAt: now };
  await saveItem(item);
  return item;
}

export function removeItem(id: string) {
  return commit({ kind: "delete", id }, (s) => ({ ...s, items: s.items.filter((x) => x.id !== id) }));
}
