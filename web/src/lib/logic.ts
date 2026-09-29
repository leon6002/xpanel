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

export const parentCat = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

/* ---- 设备 ---- */
export const KINDS: [string, string][] = [
  ["desktop", "台式机"],
  ["laptop", "笔记本"],
  ["mac", "Mac"],
  ["server", "服务器"],
  ["nas", "NAS"],
  ["phone", "手机"],
  ["other", "其他"],
];
export const kindName = (k?: string) => (KINDS.find((x) => x[0] === k) || [0, "其他"])[1];
export const devOnline = (d?: Device | null) => !!(d && d.lastSeen && Date.now() - d.lastSeen < 3 * 60000);
export function devIp(d: Device) {
  const r = (d.reportedIps || [])[0];
  if (r && devOnline(d)) return r.ip;
  const n = (d.networks || []).find((n) => n.ip);
  return n ? n.ip! : r ? r.ip : "";
}
export function seenText(d: Device) {
  if (!d.lastSeen) return "未上报（这台电脑还没装新版，或还没选设备）";
  return devOnline(d) ? "在线" : "最后在线 " + ago(d.lastSeen);
}
/** 入口按机器分组时，用主机名 / 别名 / IP 对上设备 */
export function deviceByHost(devices: Device[], key: string) {
  const k = key.toLowerCase();
  return devices.find((d) =>
    [d.name, d.hostname, ...(d.aliases || []), ...(d.networks || []).map((n) => n.ip), ...(d.reportedIps || []).map((x) => x.ip)].some((x) => x && String(x).toLowerCase() === k),
  );
}

/* ---- 入口按所在机器分组 ---- */
export type HostKind = "pc" | "server" | "web" | "disk" | "other";
const isPrivateHost = (h: string) => /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || !h.includes(".") || /\.(local|lan|home)$/i.test(h);
export function hostOf(target: string | null): { key: string; kind: HostKind } {
  if (!target) return { key: "其他", kind: "other" };
  let m: RegExpMatchArray | null;
  if ((m = target.match(/^\\\\([^\\]+)/))) return { key: m[1].toUpperCase(), kind: "pc" };
  if ((m = target.match(/^file:\/\/([^/]+)\//i)) && !/^[a-z]:$/i.test(m[1])) return { key: m[1].toUpperCase(), kind: "pc" };
  if ((m = target.match(/^smb:\/\/([^/]+)/i))) return { key: m[1].toUpperCase(), kind: "pc" };
  if ((m = target.match(/^ssh\s+(?:\S+@)?([^\s:]+)/i))) return { key: m[1].toUpperCase(), kind: "server" };
  if ((m = target.match(/^https?:\/\/([^/:]+)/i))) return isPrivateHost(m[1]) ? { key: m[1].toUpperCase(), kind: "server" } : { key: "网站", kind: "web" };
  if (/^[a-z]:\\/i.test(target)) return { key: "本机磁盘", kind: "disk" };
  if (target.startsWith("/")) return { key: "本机路径", kind: "disk" };
  return { key: "其他", kind: "other" };
}

/* ---- 附件、收件箱 ---- */
export const nowLabel = () => {
  const d = new Date();
  return `${d.getMonth() + 1}-${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
export const isImgFile = (f: File) => /^image\//.test(f.type || "");
export function fileLabel(f: File) {
  const n = (f.name || "").replace(/\.[^.]+$/, "").replace(/[[\]()]/g, "").trim();
  return !n || /^image$/i.test(n) ? (isImgFile(f) ? "截图 " : "附件 ") + nowLabel() : n;
}
export const assetMd = (isImg: boolean, label: string, name: string) => (isImg ? `![${label}](asset:${name})` : `[📎 ${label}](asset:${name})`);
/** 只有截图、没写字时自动起的标题 */
export const INBOX_AUTO = /^(截图|附件) \d+-\d+ \d\d:\d\d$/;
export const hm = (d: Date) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
export function dayLabel(d: string) {
  if (d === dateStr(new Date())) return "今天";
  if (d === addDays(-1)) return "昨天";
  const [Y, M, D] = d.split("-");
  return (+Y === new Date().getFullYear() ? "" : Y + "年") + +M + "月" + +D + "日";
}
export function shortTime(t?: string) {
  if (!t) return "";
  const [d, h] = String(t).split(" ");
  return d === dateStr(new Date()) ? h : d.slice(5).replace("-", "/");
}
/** 剪贴板里的截图在 items 里，拖进来的文件在 files 里 */
export function clipFiles(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const out = [...(dt.files || [])];
  if (!out.length)
    for (const it of [...(dt.items || [])])
      if (it.kind === "file") {
        const f = it.getAsFile();
        if (f) out.push(f);
      }
  return out;
}

/* ---- 交给 AI ---- */
export function buildPrompt(it: Item) {
  const name = it.type === "inbox" ? "收件箱" : ({ todo: "待办", issue: "问题", idea: "灵感", note: "笔记", link: "入口", rule: "规范与工作流" } as Record<string, string>)[it.type];
  const lines = [`下面是我工作台里的一条「${name}」，请帮我处理。`, "", `标题：${it.title}`];
  if (it.body) lines.push("详情：", it.body);
  if ((it.tags || []).length) lines.push("标签：" + (it.tags || []).map((x) => "#" + x).join(" "));
  if (it.device) lines.push("相关设备：" + it.device);
  lines.push("", "先说清楚你打算怎么做，需要我确认的地方先问我；做完告诉我结论和下一步。");
  return lines.join("\n");
}
export function localDirOf(it: Item) {
  const tg = entryTarget(it);
  return tg && !/^(https?|smb|ssh)/i.test(tg) ? tg : "";
}
export const hasImages = (it: Item) => /\]\(asset:[^)]+\.(png|jpe?g|gif|webp|bmp)\)/i.test(it.body || "");

/** 把正文里第 idx 张图片的显示宽度改成 w（0 = 去掉，用默认） */
export function setImageWidth(body: string, idx: number, w: number) {
  let n = -1;
  return body.replace(/!\[([^\]]*)\]\(/g, (m, alt: string) => {
    n++;
    if (n !== idx) return m;
    const base = alt.replace(/\|\d{2,4}$/, "");
    return `![${w ? base + "|" + Math.round(w) : base}](`;
  });
}
