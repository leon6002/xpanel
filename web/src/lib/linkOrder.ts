/* 入口页的分组和手动排序。
   分组就是条目的「分类」（category），所以别的地方改分类、AI 建入口时写的分类，这里都直接是分组；没分类的按所在的机器自动分。
   顺序记在条目的 rank 上（越小越靠前，跟着数据同步）：分组按组里最小的 rank 排，组里按 rank 排。
   这里只算「拖完之后哪些条目要改什么」，不碰界面和网络。 */
import { entryTargets, hostOf, type HostKind } from "./logic";
import type { Item } from "./types";

export interface LinkGroup {
  key: string;
  /** 自己建的分组是分类的名字；自动分的是 null */
  cat: string | null;
  /** 自动分组是哪种机器 */
  kind: HostKind | null;
  items: Item[];
}
export interface LinkPatch {
  id: string;
  set: { category?: string | undefined; rank?: number };
}

const STEP = 1024;
const HOST_ORDER: Record<HostKind, number> = { pc: 0, server: 1, disk: 2, web: 3, other: 4 };
const rk = (it: Item) => (typeof it.rank === "number" && Number.isFinite(it.rank) ? it.rank : Infinity);
const hostKey = (it: Item) => hostOf(entryTargets(it)[0] ?? null);
export const autoKey = (it: Item) => "auto:" + hostKey(it).key;

/** 排好的分组：自己建的在前（按组里最靠前的那条排，空的分组在后面），自动分的在最后 */
export function buildGroups(links: Item[], empty: string[] = []): LinkGroup[] {
  const custom = new Map<string, LinkGroup>();
  const auto = new Map<string, LinkGroup>();
  for (const it of links) {
    if (it.category) {
      if (!custom.has(it.category)) custom.set(it.category, { key: "cat:" + it.category, cat: it.category, kind: null, items: [] });
      custom.get(it.category)!.items.push(it);
    } else {
      const h = hostKey(it);
      if (!auto.has(h.key)) auto.set(h.key, { key: "auto:" + h.key, cat: null, kind: h.kind, items: [] });
      auto.get(h.key)!.items.push(it);
    }
  }
  const byRank = (a: Item, b: Item) => rk(a) - rk(b) || Number(!!b.pinned) - Number(!!a.pinned) || a.title.localeCompare(b.title, "zh");
  for (const g of [...custom.values(), ...auto.values()]) g.items.sort((a, b) => (rk(a) === rk(b) ? byRank(a, b) : rk(a) - rk(b)));
  const top = (g: LinkGroup) => Math.min(...g.items.map(rk));
  const filled = [...custom.values()].sort((a, b) => (top(a) === top(b) ? a.cat!.localeCompare(b.cat!, "zh") : top(a) - top(b)));
  const blank = empty.filter((c) => c && !custom.has(c)).map((c) => ({ key: "cat:" + c, cat: c, kind: null, items: [] }));
  const autos = [...auto.values()].sort((a, b) => HOST_ORDER[a.kind!] - HOST_ORDER[b.kind!] || a.key.localeCompare(b.key));
  return [...filled, ...blank, ...autos];
}

/** 按现在的排法，每条该是什么 rank：只动了一条、而且夹在前后两条之间放得下，就只改它；否则从头重新编号 */
function rerank(groups: LinkGroup[], moved?: string): Map<string, number> {
  const flat = groups.flatMap((g) => g.items);
  const out = new Map<string, number>();
  const i = moved ? flat.findIndex((x) => x.id === moved) : -1;
  if (i >= 0) {
    const prev = i > 0 ? rk(flat[i - 1]) : -Infinity;
    const next = i < flat.length - 1 ? rk(flat[i + 1]) : Infinity;
    const cand = prev === -Infinity && next === Infinity ? STEP : prev === -Infinity ? next - STEP : next === Infinity ? prev + STEP : (prev + next) / 2;
    const vals = flat.map((x, k) => (k === i ? cand : rk(x)));
    if (vals.every((v, k) => Number.isFinite(v) && (k === 0 || v > vals[k - 1]))) {
      if (cand !== rk(flat[i])) out.set(moved!, cand);
      return out;
    }
  }
  flat.forEach((x, k) => {
    if (x.rank !== (k + 1) * STEP) out.set(x.id, (k + 1) * STEP);
  });
  return out;
}

const toPatches = (ranks: Map<string, number>, extra?: LinkPatch): LinkPatch[] => {
  const out: LinkPatch[] = [...ranks].filter(([id]) => id !== extra?.id).map(([id, rank]) => ({ id, set: { rank } }));
  if (extra) {
    const r = ranks.get(extra.id);
    const set = { ...extra.set, ...(r === undefined ? {} : { rank: r }) };
    if (Object.keys(set).length) out.unshift({ id: extra.id, set });
  }
  return out;
};

/** 把一条拖到某个分组里、排在 before 那条前面（before 为空 = 放到最后）。
    拖到自动分组等于取消分组：它会回到自己所在机器的那一组，只有正好拖进那一组时位置才算数 */
export function planMove(groups: LinkGroup[], id: string, toKey: string, before: string | null): LinkPatch[] {
  const it = groups.flatMap((g) => g.items).find((x) => x.id === id);
  const to = groups.find((g) => g.key === toKey);
  if (!it || !to || before === id) return [];
  const destKey = to.cat !== null ? to.key : autoKey(it);
  const positional = destKey === toKey;
  const next = groups.map((g) => ({ ...g, items: g.items.filter((x) => x.id !== id) }));
  let dest = next.find((g) => g.key === destKey);
  if (!dest) {
    const h = hostKey(it);
    dest = { key: destKey, cat: null, kind: h.kind, items: [] };
    next.push(dest);
  }
  const at = positional && before ? dest.items.findIndex((x) => x.id === before) : -1;
  const moved: Item = { ...it, category: to.cat ?? undefined };
  dest.items.splice(at < 0 ? dest.items.length : at, 0, moved);
  const cat: LinkPatch["set"] = (it.category || null) === to.cat ? {} : { category: to.cat ?? undefined };
  const changed = "category" in cat;
  return toPatches(rerank(next, id), changed ? { id, set: cat } : { id, set: {} });
}

/** 把一个自己建的分组挪到另一个分组前面（before 为空 = 挪到自己建的分组的最后） */
export function planGroupMove(groups: LinkGroup[], key: string, before: string | null): LinkPatch[] {
  const g = groups.find((x) => x.key === key);
  if (!g || g.cat === null || !g.items.length || before === key) return [];
  const rest = groups.filter((x) => x.key !== key);
  let at = before ? rest.findIndex((x) => x.key === before) : -1;
  // 只能排在自己建的、有内容的分组之间
  const lastFilled = rest.reduce((m, x, i) => (x.cat !== null && x.items.length ? i : m), -1);
  if (at < 0 || at > lastFilled + 1) at = lastFilled + 1;
  rest.splice(at, 0, g);
  return toPatches(rerank(rest));
}
