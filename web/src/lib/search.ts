/* 搜索的打分，全局搜索（条目）和密码库共用。全在本机做。
   - 多个词不分顺序，都要对得上
   - 打一部分、漏几个字母（gthb → GitHub）、错一个字母（githup）都能搜到（只对名称这类短的栏；正文太长，只认原样出现的）
   - 一个词对一栏的分：完全一样 > 开头 > 包含 > 字母按顺序出现 > 差一个字母，再乘这一栏的权重 */
import { noteTitle, plain } from "./logic";
import type { Item } from "./types";

/** 一栏：内容（小写）、权重、要不要容错 */
export type SearchField = [text: string, weight: number, fuzzy: boolean];

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

export const tokensOf = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean);

/** 这几个词对这几栏的总分；有一个词哪栏都对不上就是 0 */
export function scoreFields(toks: string[], fields: SearchField[]) {
  let total = 0;
  for (const t of toks) {
    let best = 0;
    for (const [text, w, fuzzy] of fields) best = Math.max(best, hit(t, text, fuzzy) * w);
    if (!best) return 0;
    total += best;
  }
  return total;
}

/* ---- 条目（事项、笔记、收件箱、入口、规范） ---- */
export interface ItemHit { item: Item; score: number; title: string; snippet: string }

const low = (s?: string) => (s || "").toLowerCase();
/** 收件箱里随手发的，标题是自动从正文截的：直接显示正文 */
export const titleOfItem = (it: Item) => (it.type === "inbox" ? plain(it.body || it.title).slice(0, 90) : noteTitle(it)) || "（没有标题）";

/** 正文里对上的那一段；没对上就取开头 */
function snippetOf(body: string, toks: string[]) {
  const text = plain(body);
  const l = text.toLowerCase();
  let at = -1;
  for (const t of toks) {
    const i = l.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return text.slice(0, 90);
  const from = Math.max(0, at - 24);
  return (from ? "…" : "") + text.slice(from, from + 100);
}

export function searchItems(items: Item[], q: string): ItemHit[] {
  const toks = tokensOf(q);
  if (!toks.length) return [];
  const now = Date.now();
  const out: ItemHit[] = [];
  for (const it of items) {
    const title = titleOfItem(it);
    const comments = (it.qa || []).flatMap((x) => [x.quote, ...x.turns.flatMap((t) => [t.q, t.a])]).join("\n");
    const fields: SearchField[] = [
      [low(title), 10, true],
      [low((it.tags || []).join(" ")), 6, true],
      [low(it.category), 5, true],
      [low(it.body), 3, false],
      [low(comments), 1.5, false],
    ];
    let score = scoreFields(toks, fields);
    if (!score) continue;
    // 同样对得上时：置顶的、没做完的、最近改过的靠前；做完的靠后
    score += (it.pinned ? 1 : 0) + (it.done ? -2 : 0) + (now - it.updatedAt < 7 * 864e5 ? 1 : now - it.updatedAt < 30 * 864e5 ? 0.5 : 0);
    out.push({ item: it, score, title, snippet: it.type === "inbox" ? "" : snippetOf(it.body || "", toks) });
  }
  return out.sort((a, b) => b.score - a.score || b.item.updatedAt - a.item.updatedAt);
}
