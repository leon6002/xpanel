/* 和界面无关的小逻辑：日期、优先级、快速记录语法、入口地址识别、分类 */
import type { Device, Item, ItemType, Priority } from "./types";

export const pad2 = (n: number) => String(n).padStart(2, "0");
export const dateStr = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
export function addDays(n: number) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return dateStr(d);
}

export function ago(ts?: number) {
  if (!ts) return "";
  const d = (Date.now() - ts) / 1000;
  if (d < 60) return "刚刚";
  if (d < 3600) return `${Math.floor(d / 60)} 分钟前`;
  if (d < 86400) return `${Math.floor(d / 3600)} 小时前`;
  if (d < 86400 * 30) return `${Math.floor(d / 86400)} 天前`;
  const x = new Date(ts);
  return `${x.getMonth() + 1}月${x.getDate()}日`;
}

/** 「明天」「下周一」「10-8」「+3天」→ YYYY-MM-DD */
export function parseDue(s: string): string | null {
  s = s.trim();
  let m: RegExpMatchArray | null;
  const words: Record<string, number> = { 今天: 0, 明天: 1, 后天: 2, 大后天: 3 };
  if (s in words) return addDays(words[s]);
  if ((m = s.match(/^\+?(\d{1,3})天后?$/))) return addDays(+m[1]);
  if ((m = s.match(/^(下)?(?:周|星期|礼拜)([一二三四五六日天])$/))) {
    const w = "日一二三四五六".indexOf(m[2] === "天" ? "日" : m[2]);
    const today = new Date().getDay();
    if (m[1]) {
      const mon = (today + 6) % 7, target = (w + 6) % 7;
      return addDays(7 - mon + target);
    }
    return addDays((w - today + 7) % 7);
  }
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return `${m[1]}-${pad2(+m[2])}-${pad2(+m[3])}`;
  if ((m = s.match(/^(\d{1,2})[-/.月](\d{1,2})日?$/))) {
    const y = new Date().getFullYear();
    let d = `${y}-${pad2(+m[1])}-${pad2(+m[2])}`;
    if (d < addDays(0)) d = `${y + 1}-${pad2(+m[1])}-${pad2(+m[2])}`;
    return d;
  }
  return null;
}

export function normPri(s: string): Priority | null {
  const x = String(s || "").trim().toUpperCase().replace(/^P/, "");
  const w = ({ 紧急: "0", 高: "1", 中: "2", 低: "3" } as Record<string, string>)[x] ?? x;
  return /^[0-3]$/.test(w) ? (("P" + w) as Priority) : null;
}

export function dueInfo(it: Item): { text: string; tone: "late" | "soon" | "" } | null {
  if (!it.due || it.done) return null;
  const days = Math.round((+new Date(it.due + "T00:00:00") - +new Date(addDays(0) + "T00:00:00")) / 864e5);
  const text =
    days === 0 ? "今天到期" : days === 1 ? "明天到期" : days === -1 ? "昨天到期" : days < 0 ? `逾期 ${-days} 天` : days < 7 ? `${days} 天后到期` : `截止 ${+it.due.slice(5, 7)}-${+it.due.slice(8, 10)}`;
  return { text, tone: days < 0 ? "late" : days <= 1 ? "soon" : "" };
}

const priRank = (it: Item) => {
  const i = ["P0", "P1", "P2", "P3"].indexOf(it.priority ?? "");
  return i < 0 ? 9 : i;
};
export const byRecent = (a: Item, b: Item) => (b.updatedAt || 0) - (a.updatedAt || 0);
export const byPriority = (a: Item, b: Item) =>
  Number(!!b.pinned) - Number(!!a.pinned) || priRank(a) - priRank(b) || (a.due || "9999").localeCompare(b.due || "9999") || byRecent(a, b);

/* ---- 入口：识别网址 / 路径 ---- */
const RE_URL = /(?:https?|smb):\/\/[^\s<>"`]+/i;
const RE_FILEURL = /file:\/\/[^\s<>"`]+/i;
const RE_UNC = /\\\\[^\s\\<>"`|?*]+(?:\\[^\n<>"`|?*]*)?/;
const RE_DRIVE = /\b[A-Za-z]:\\[^\n<>"`|?*]*/;
const RE_POSIX = /(?:^|\s)(\/(?:Volumes|mnt|home|Users|srv|data)\/[^\s<>"`]*)/;
const RE_SSH = /\bssh\s+[^\n`]+/;
export function findTarget(text: string): string | null {
  for (const re of [RE_URL, RE_FILEURL, RE_UNC, RE_DRIVE]) {
    const m = text.match(re);
    if (m) return m[0].trim().replace(/[，。；,;]+$/, "");
  }
  const p = text.match(RE_POSIX);
  if (p) return p[1].trim();
  const s = text.match(RE_SSH);
  if (s) return s[0].trim();
  return null;
}
export const entryTarget = (it: Item) => findTarget((it.body || "") + "\n" + (it.title || ""));
export function autoTitle(target: string) {
  const t = target.replace(/[\\/]+$/, "");
  if (/^https?:\/\//i.test(t)) {
    try {
      const u = new URL(t);
      return (u.hostname + (u.pathname !== "/" ? u.pathname : "")).replace(/\/$/, "");
    } catch {
      return t;
    }
  }
  const seg = t.split(/[\\/]/).filter(Boolean);
  return seg[seg.length - 1] || t;
}

/* ---- 快速记录：#标签 @设备 !1 ~明天 ---- */
export function findDevice(devices: Device[], s: string) {
  const k = s.toLowerCase();
  return devices.find((d) => d.name.toLowerCase() === k || ((d.aliases as string[] | undefined) ?? []).some((a) => a.toLowerCase() === k));
}
export function parseCapture(raw: string, type: ItemType, devices: Device[]) {
  const tags: string[] = [];
  let device = "", priority: Priority | "" = "", due = "";
  const text = raw
    .replace(/(^|\s)!(P?[0-3]|紧急|高|中|低)(?=\s|$)/gi, (m, a: string, x: string) => {
      const p = normPri(x);
      if (!p) return m;
      priority = p;
      return a;
    })
    .replace(/(^|\s)~(\S+)(?=\s|$)/g, (m, a: string, x: string) => {
      const d = parseDue(x);
      if (!d) return m;
      due = d;
      return a;
    })
    .replace(/(^|\s)#([^\s#@\\/]+)/g, (_m, a: string, t: string) => {
      tags.push(t);
      return a;
    })
    .replace(/(^|\s)@([^\s#@]+)(?=\s|$)/g, (m, a: string, d: string) => {
      const dv = findDevice(devices, d);
      if (!dv) return m;
      device = dv.name;
      return a;
    });
  const lines = text.split("\n").map((s) => s.trim()).filter(Boolean);
  let title = lines.shift() || "", body = lines.join("\n");
  if (type === "link") {
    const tg = findTarget(title);
    if (tg && tg.length >= title.length - 2) {
      body = [tg, body].filter(Boolean).join("\n");
      title = autoTitle(tg);
    }
  }
  return { title, body, tags, device, priority, due };
}

/* ---- 分类：/ 分层 ---- */
export const normCat = (s: string) => String(s || "").split(/[/\\]/).map((x) => x.trim()).filter(Boolean).slice(0, 5).join("/");
export const inCat = (c: string | undefined, p: string) => !!c && (c === p || c.startsWith(p + "/"));
export function allCats(items: Item[], extra: string[] = []) {
  const set = new Set<string>();
  const add = (p?: string) => {
    if (!p) return;
    let cur = "";
    for (const seg of p.split("/")) {
      cur = cur ? cur + "/" + seg : seg;
      set.add(cur);
    }
  };
  extra.forEach(add);
  items.forEach((i) => add(i.category));
  return [...set].sort((a, b) => a.localeCompare(b, "zh"));
}
export function allTags(items: Item[]) {
  const m = new Map<string, number>();
  items.forEach((i) => (i.tags || []).forEach((t) => m.set(t, (m.get(t) || 0) + 1)));
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh"));
}

/** 笔记没写标题时用正文开头 */
export const plain = (s?: string) =>
  String(s || "").replace(/!\[[^\]]*\]\([^)]*\)/g, "[图片]").replace(/[#>*_`~-]+/g, " ").replace(/\s+/g, " ").trim();
export const noteTitle = (it: Item) => it.title || plain(it.body).slice(0, 30) || "无标题笔记";
export const imageRefs = (body?: string) => [...String(body || "").matchAll(/!\[[^\]]*\]\(asset:([A-Za-z0-9._-]+)\)/g)].map((m) => m[1]);
