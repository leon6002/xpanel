/* 关联：任意两条之间可以互相关联，关联时可以写个标签（岗位、简历、题库…）。
   存在发起方的 links 字段：[{id, label?}]；另一边自动显示成「被关联」。
   正文里写 [标题](xpanel:item/ID)（编辑器里输入 [[ 选一篇）也算关联。 */
import { patchItem, qc } from "./data";
import type { Item, State } from "./types";

export interface ItemLink {
  id: string;
  label?: string;
}
export interface Related {
  item: Item;
  label?: string;
  /** out：这条关联的别人；in：别人关联了这条；ref：正文里引用的 */
  dir: "out" | "in" | "ref";
}

export const LABELS = ["岗位", "简历", "题库", "流程", "工具", "参考", "产出"];
export const REF_PREFIX = "xpanel:item/";
const RE_REF = /\]\(xpanel:item\/([A-Za-z0-9_-]+)\)/g;

const all = () => qc.getQueryData<State>(["state"])?.items ?? [];
const latest = (it: Item) => all().find((x) => x.id === it.id) ?? it;

export const linksOf = (it: Item): ItemLink[] => (Array.isArray(it.links) ? (it.links as ItemLink[]).filter((l) => l && typeof l.id === "string") : []);
export const bodyRefs = (body?: string) => [...String(body || "").matchAll(RE_REF)].map((m) => m[1]);

/** 这一条的所有关联（去重：同一条先按「关联」，再按「被关联」，最后是正文引用） */
export function relatedOf(items: Item[], it: Item): Related[] {
  const byId = new Map(items.map((x) => [x.id, x]));
  const out: Related[] = [];
  const seen = new Set<string>([it.id]);
  for (const l of linksOf(it)) {
    const x = byId.get(l.id);
    if (!x || seen.has(x.id)) continue;
    seen.add(x.id);
    out.push({ item: x, label: l.label, dir: "out" });
  }
  for (const x of items) {
    if (seen.has(x.id)) continue;
    const l = linksOf(x).find((l) => l.id === it.id);
    if (!l) continue;
    seen.add(x.id);
    out.push({ item: x, label: l.label, dir: "in" });
  }
  for (const id of bodyRefs(it.body)) {
    const x = byId.get(id);
    if (!x || seen.has(x.id)) continue;
    seen.add(x.id);
    out.push({ item: x, dir: "ref" });
  }
  return out;
}

/** 关联到另一条（已关联就只改标签） */
export function addLink(it: Item, id: string, label?: string) {
  const cur = latest(it);
  const list = linksOf(cur).filter((l) => l.id !== id);
  list.push(label ? { id, label } : { id });
  return patchItem(cur, { links: list });
}

/** 改标签：关联存在哪边就改哪边 */
export function setLabel(it: Item, r: Related, label: string) {
  const owner = r.dir === "in" ? latest(r.item) : latest(it);
  const target = r.dir === "in" ? it.id : r.item.id;
  const list = linksOf(owner).map((l) => (l.id === target ? (label ? { id: l.id, label } : { id: l.id }) : l));
  if (r.dir === "ref") list.push(label ? { id: target, label } : { id: target });
  return patchItem(owner, { links: list });
}

/** 取消关联（两边都清掉；正文里的引用不动） */
export async function removeLink(it: Item, other: Item) {
  const a = latest(it);
  if (linksOf(a).some((l) => l.id === other.id)) await patchItem(a, { links: linksOf(a).filter((l) => l.id !== other.id) });
  const b = latest(other);
  if (linksOf(b).some((l) => l.id === it.id)) await patchItem(b, { links: linksOf(b).filter((l) => l.id !== it.id) });
}
