/* 密码库的搜索和排序。解锁后内容都在本机内存里，所以搜索全在本机做，什么都不发给主机。
   - 多个词不分顺序，都要对得上
   - 打一部分、漏几个字母（gthb → GitHub）、错一个字母（githup）都能搜到
   - 名称、域名最重要，其次用户名、标签，再次自定义栏的名字、备注和待整理的原文；不搜密码本身
   - 常用的、最近用过的、置顶的排前面 */
import { ls } from "./store";
import type { Fields, SecretRec } from "./vault";

export interface Entry { s: SecretRec; f: Fields | null }

export const domainOf = (url?: string) =>
  (url || "")
    .trim()
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/^[^/@]*@/, "")
    .split(/[/?#]/)[0]
    .replace(/^www\./i, "")
    .toLowerCase();
/** 显示用的名称：解开了用密文里的，没解开只能用主机上的标签 */
export const titleOf = (e: Entry) => e.f?.title || e.s.title;

/* ---- 用过几次、上次什么时候用的（只记在这台电脑的浏览器里，只有条目的标识，没有内容） ---- */
type Usage = Record<string, { n: number; at: number }>;
const KEY = "wb-vault-usage";
let usage: Usage | null = null;
export function getUsage(): Usage {
  if (!usage) {
    try {
      usage = JSON.parse(ls.get(KEY) || "{}") as Usage;
    } catch {
      usage = {};
    }
  }
  return usage;
}
export function bumpUsage(id: string) {
  const u = getUsage();
  u[id] = { n: (u[id]?.n ?? 0) + 1, at: Date.now() };
  // 只留最近用过的 300 条
  const keep = Object.entries(u)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, 300);
  usage = Object.fromEntries(keep);
  ls.set(KEY, JSON.stringify(usage));
}

/* ---- 匹配 ---- */
/** q 的字母按顺序都出现在 s 里（中间可以隔几个）：返回 0–1 的分，隔得越开越低；对不上返回 0 */
function subseq(q: string, s: string) {
  let i = 0,
    first = -1,
    last = -1;
  for (let j = 0; j < s.length && i < q.length; j++) {
    if (s[j] === q[i]) {
      if (first < 0) first = j;
      last = j;
      i++;
    }
  }
  if (i < q.length) return 0;
  const span = last - first + 1;
  return span > q.length * 3 ? 0 : q.length / span;
}
/** 只差一个字母（多一个、少一个、错一个、相邻两个打反了） */
function near(a: string, b: string) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const ra = a.slice(i),
    rb = b.slice(i);
  return ra.slice(1) === rb.slice(1) || ra.slice(1) === rb || ra === rb.slice(1) || (ra.length > 1 && rb.length > 1 && ra[0] === rb[1] && ra[1] === rb[0] && ra.slice(2) === rb.slice(2));
}
const words = (s: string) => s.split(/[^a-z0-9一-鿿]+/).filter(Boolean);

/** 一个词对一栏的分：完全一样 > 开头 > 包含 > 字母按顺序出现 > 差一个字母 */
function hit(tok: string, field: string, fuzzy: boolean) {
  if (!field) return 0;
  if (field === tok) return 3;
  if (field.startsWith(tok)) return 2.2;
  const at = field.indexOf(tok);
  if (at >= 0) return /[^a-z0-9]/.test(field[at - 1] ?? " ") ? 1.9 : 1.5;
  if (!fuzzy || tok.length < 2 || /[一-鿿]/.test(tok)) return 0;
  const sub = subseq(tok, field);
  if (sub) return 0.4 + 0.5 * sub;
  if (tok.length >= 4 && words(field).some((w) => near(tok, w.slice(0, tok.length + 1)) || near(tok, w))) return 0.5;
  return 0;
}

function fieldsOf(e: Entry): [string, number, boolean][] {
  const f = e.f;
  const low = (s?: string) => (s || "").toLowerCase();
  return [
    [low(titleOf(e)), 10, true],
    [domainOf(f?.url), 8, true],
    [low(f?.username), 6, true],
    [low((f?.tags ?? []).join(" ")), 6, true],
    [low((f?.extra ?? []).map((x) => x.label).join(" ")), 3, false],
    [low(f?.url), 3, false],
    [low(f?.notes), 2, false],
    [low(f?.raw), 2, false],
  ];
}

/** 搜索：返回对得上的，最相关的在前。q 为空时返回全部（按 sortEntries 的顺序） */
export function searchVault(entries: Entry[], q: string): Entry[] {
  const toks = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!toks.length) return sortEntries(entries);
  const u = getUsage();
  const now = Date.now();
  const scored: [number, Entry][] = [];
  for (const e of entries) {
    const fs = fieldsOf(e);
    let total = 0;
    let ok = true;
    for (const t of toks) {
      let best = 0;
      for (const [text, w, fuzzy] of fs) best = Math.max(best, hit(t, text, fuzzy) * w);
      if (!best) {
        ok = false;
        break;
      }
      total += best;
    }
    if (!ok) continue;
    const use = u[e.s.id];
    total += (use ? Math.log2(use.n + 1) + (now - use.at < 7 * 864e5 ? 1.5 : 0) : 0) + (e.f?.pinned ? 1 : 0);
    scored.push([total, e]);
  }
  return scored.sort((a, b) => b[0] - a[0] || titleOf(a[1]).localeCompare(titleOf(b[1]))).map((x) => x[1]);
}

/** 不搜索时的顺序：同一个网站（域名）的排在一起，然后按名称 */
export function sortEntries(entries: Entry[]): Entry[] {
  const key = (e: Entry) => (domainOf(e.f?.url).split(".").slice(-2).join(".") || titleOf(e)).toLowerCase();
  return entries.slice().sort((a, b) => key(a).localeCompare(key(b)) || titleOf(a).localeCompare(titleOf(b)));
}

/** 最近用过的几条（30 天内） */
export function recentEntries(entries: Entry[], n = 5): Entry[] {
  const u = getUsage();
  const now = Date.now();
  return entries
    .filter((e) => u[e.s.id] && now - u[e.s.id].at < 30 * 864e5)
    .sort((a, b) => u[b.s.id].at - u[a.s.id].at)
    .slice(0, n);
}
