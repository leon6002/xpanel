/* 密码库的搜索和排序。解锁后内容都在本机内存里，所以搜索全在本机做，什么都不发给主机。
   - 多个词不分顺序，都要对得上
   - 打一部分、漏几个字母（gthb → GitHub）、错一个字母（githup）都能搜到
   - 名称、域名最重要，其次用户名、标签，再次自定义栏的名字、备注和待整理的原文；不搜密码本身
   - 常用的、最近用过的、置顶的排前面 */
import { scoreFields, tokensOf, type SearchField } from "./search";
import { ls } from "./store";
import { isMailbox, platformOf } from "./platforms";
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

function fieldsOf(e: Entry): SearchField[] {
  const f = e.f;
  const low = (s?: string) => (s || "").toLowerCase();
  const p = platformOf(f);
  return [
    [low(f?.label), 6, true],
    // 平台的名字和别名：搜「苹果」「谷歌」「招行」也能找到
    [p ? low([p.name, ...p.aliases].join(" ")) : "", 5, false],
    [low(titleOf(e)), 10, true],
    [domainOf(f?.url), 8, true],
    [low(f?.username), 6, true],
    [low((f?.tags ?? []).join(" ")), 6, true],
    [low((f?.extra ?? []).map((x) => x.label).join(" ")), 3, false],
    [low(f?.url), 3, false],
    // 卡号：一般是搜后四位
    [(f?.card || "").replace(/\D/g, ""), 5, false],
    [f?.kind === "bank" ? (f.sub === "credit" ? "银行 信用卡" : "银行 手机银行") : "", 2, false],
    [isMailbox(f) ? "邮箱 email mail" : "", 2, false],
    [low(f?.notes), 2, false],
    [low(f?.raw), 2, false],
  ];
}

/** 搜索：返回对得上的和分数，最相关的在前 */
export function scoreVault(entries: Entry[], q: string): { e: Entry; score: number }[] {
  const toks = tokensOf(q);
  const u = getUsage();
  const now = Date.now();
  const scored: { e: Entry; score: number }[] = [];
  for (const e of entries) {
    let total = scoreFields(toks, fieldsOf(e));
    if (!total) continue;
    const use = u[e.s.id];
    total += (use ? Math.log2(use.n + 1) + (now - use.at < 7 * 864e5 ? 1.5 : 0) : 0) + (e.f?.pinned ? 1 : 0);
    scored.push({ e, score: total });
  }
  return scored.sort((a, b) => b.score - a.score || titleOf(a.e).localeCompare(titleOf(b.e)));
}
/** 搜索：返回对得上的，最相关的在前。q 为空时返回全部（按 sortEntries 的顺序） */
export const searchVault = (entries: Entry[], q: string): Entry[] => (tokensOf(q).length ? scoreVault(entries, q).map((x) => x.e) : sortEntries(entries));

/** 不搜索时的顺序：同一个平台、同一个网站（域名）的排在一起，然后按名称 */
export function sortEntries(entries: Entry[]): Entry[] {
  const key = (e: Entry) => (platformOf(e.f)?.id || domainOf(e.f?.url).split(".").slice(-2).join(".") || titleOf(e)).toLowerCase();
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
