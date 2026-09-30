/* 笔记的层级：子笔记在 parentId 里记着父笔记。
   父笔记找不到（被删了、还没同步过来）时当顶层显示；删父笔记时子笔记往上挪一层（主机那边处理）。 */
import { create } from "zustand";
import { addItem, patchItem, qc } from "./data";
import { ls } from "./store";
import type { Item, State } from "./types";

export const TREE_TYPES = ["note", "rule"];
export const canNest = (it: Item) => TREE_TYPES.includes(it.type);

const byOrder = (a: Item, b: Item) => (a.rank ?? 1e15) - (b.rank ?? 1e15) || a.createdAt - b.createdAt;

/** 按 id 建好父子关系，列表和阅读区都用它 */
export function buildTree(items: Item[]) {
  const byId = new Map(items.map((x) => [x.id, x]));
  const kids = new Map<string, Item[]>();
  for (const it of items) {
    const p = it.parentId;
    if (!p || p === it.id || !byId.has(p)) continue;
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p)!.push(it);
  }
  kids.forEach((l) => l.sort(byOrder));
  const parent = (it: Item) => (it.parentId && it.parentId !== it.id ? byId.get(it.parentId) : undefined);
  /** 从顶层到直接父笔记；防环 */
  const ancestors = (it: Item) => {
    const out: Item[] = [];
    const seen = new Set([it.id]);
    let p = parent(it);
    while (p && !seen.has(p.id)) {
      out.unshift(p);
      seen.add(p.id);
      p = parent(p);
    }
    return out;
  };
  const children = (id: string) => kids.get(id) ?? [];
  const descendants = (id: string) => {
    const out = new Set<string>();
    const walk = (x: string) =>
      children(x).forEach((c) => {
        if (out.has(c.id)) return;
        out.add(c.id);
        walk(c.id);
      });
    walk(id);
    return out;
  };
  // 有环的时候（两条互为父，只可能是外部改出来的）让它们都当顶层，免得谁都看不见；渲染时另有防重复
  const inCycle = (it: Item) => {
    const seen = new Set<string>();
    let p = parent(it);
    while (p && !seen.has(p.id)) {
      if (p.id === it.id) return true;
      seen.add(p.id);
      p = parent(p);
    }
    return !!p; // 往上走绕回了圈里：也当顶层
  };
  const isRoot = (it: Item) => !parent(it) || inCycle(it);
  return { byId, parent, ancestors, children, descendants, isRoot };
}

/** 列表里哪些笔记展开了子笔记（记在本机） */
export const useOpenNodes = create<{ open: Record<string, boolean>; toggle: (id: string, v?: boolean) => void }>((set) => ({
  open: (() => {
    try {
      return JSON.parse(ls.get("wb-tree-open") || "{}");
    } catch {
      return {};
    }
  })(),
  toggle: (id, v) =>
    set((s) => {
      const open = { ...s.open, [id]: v ?? !s.open[id] };
      if (!open[id]) delete open[id];
      ls.set("wb-tree-open", JSON.stringify(open));
      return { open };
    }),
}));

/** 新建子笔记：跟父笔记同类型、同分类 */
export async function addChild(parent: Item) {
  const n = await addItem({ type: parent.type, title: "", body: "", parentId: parent.id, category: parent.category || undefined, tags: [] });
  useOpenNodes.getState().toggle(parent.id, true);
  return n;
}

/** 挪到另一篇下面（null = 顶层） */
export function moveUnder(it: Item, parentId: string | null) {
  const cur = qc.getQueryData<State>(["state"])?.items.find((x) => x.id === it.id) ?? it;
  if (parentId) useOpenNodes.getState().toggle(parentId, true);
  return patchItem(cur, { parentId: parentId || undefined });
}
