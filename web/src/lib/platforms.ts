/* 平台：一条是哪个平台的账号（Google、Apple、招商银行…）。用来显示 logo、把同一个平台的几个账号排成一组、新建时预选。
   记在密文里的 platform（"none" = 用户明确说不是任何平台）；没记的按名称和网址认。数据在 platformData.ts。 */
import { PLATFORMS, type Platform } from "./platformData";

export type { Platform };
export { PLATFORMS };
const BY = new Map(PLATFORMS.map((p) => [p.id, p]));
export const platformById = (id?: string | null) => (id ? BY.get(id) : undefined);

const hostOf = (url?: string) =>
  (url || "")
    .trim()
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/^[^/@]*@/, "")
    .split(/[/?#:]/)[0]
    .toLowerCase();

/** 别名在不在这段话里：英文要是完整的词（免得 ea 认到 team 里），中文包含就算 */
function has(text: string, alias: string) {
  const at = text.indexOf(alias);
  if (at < 0) return false;
  if (/[一-鿿]/.test(alias)) return true;
  const edge = (c?: string) => !c || !/[a-z0-9]/.test(c);
  return edge(text[at - 1]) && edge(text[at + alias.length]);
}

/** 从名称和网址认平台。bank：只在银行里认，否则只在其他平台里认。认到几个时取别名最长的 */
export function detectPlatform(o: { title?: string; url?: string; email?: string }, bank: boolean): Platform | undefined {
  const pool = PLATFORMS.filter((p) => !!p.bank === bank);
  const title = (o.title || "").toLowerCase();
  let best: Platform | undefined;
  let len = 0;
  for (const p of pool)
    for (const a of p.aliases)
      if (a.length > len && has(title, a)) {
        best = p;
        len = a.length;
      }
  if (best) return best;
  const host = hostOf(o.url);
  const byHost = (h: string) => (h ? pool.filter((p) => p.domains.some((d) => h === d || h.endsWith("." + d))).sort((a, b) => Math.max(...b.domains.map((d) => d.length)) - Math.max(...a.domains.map((d) => d.length)))[0] : undefined);
  return byHost(host) ?? byHost((o.email || "").split("@")[1]?.toLowerCase() ?? "");
}

/** 这段话里有没有提到哪家银行（随手记的原文用） */
export const mentionsBank = (text: string) => {
  const t = text.toLowerCase();
  return PLATFORMS.some((p) => p.bank && p.aliases.some((a) => (a.length >= 3 || /[一-鿿]/.test(a)) && has(t, a)));
};

/** 这一条的平台：记了就用记的，没记的按名称和网址认 */
export function platformOf(f?: { kind: string; title: string; url?: string; platform?: string } | null): Platform | undefined {
  if (!f || f.kind === "raw" || f.platform === "none") return undefined;
  return platformById(f.platform) ?? detectPlatform(f, f.kind === "bank");
}

/* ---- 邮箱 ---- */
type MailLike = { kind: string; title: string; url?: string; platform?: string; username?: string; mail?: boolean };
const domainOfMail = (v?: string) => (v || "").trim().toLowerCase().match(/^[^\s@]+@([^\s@]+\.[^\s@]+)$/)?.[1];
/** 账号栏填的是邮箱地址的话，就是它（小写） */
export const emailOf = (f?: { username?: string } | null) => (domainOfMail(f?.username) ? f!.username!.trim().toLowerCase() : undefined);
/** 这一条是不是邮箱账号：用户勾过的以勾的为准；否则纯邮箱服务算，账号是平台自家邮箱地址的算
    （@icloud.com 的 Apple ID、@gmail.com 的 Google 账号），名称里写了「邮箱」的也算 */
export function isMailbox(f?: MailLike | null): boolean {
  if (!f || f.kind !== "login") return false;
  if (f.mail != null) return f.mail;
  const p = platformOf(f);
  if (p?.mailOnly) return true;
  const d = domainOfMail(f.username);
  if (p && d && p.mail?.includes(d)) return true;
  return /邮箱|e-?mail/i.test(f.title);
}

/** 名称去掉前面的平台名，剩下的用来区分同一个平台的几个账号（「Apple · 美区」→「美区」） */
export function shortTitle(title: string, p: Platform) {
  const low = title.toLowerCase();
  for (const a of [p.name.toLowerCase(), ...p.aliases].sort((x, y) => y.length - x.length))
    if (low.startsWith(a)) {
      const rest = title
        .slice(a.length)
        .replace(/^(?:账号|帐号|信用卡)?[\s·\-—:：（(]+/, "")
        .replace(/[)）]$/, "")
        .trim();
      if (rest) return rest;
    }
  return "";
}

/** 主机上登记的名称：平台名加用途，锁着时和给 AI 的列表里分得清是哪个 */
export const composeTitle = (base: string, label?: string) => (label && !base.includes(label) ? `${base} · ${label}` : base);
