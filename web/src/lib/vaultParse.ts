/* 把快速记下的一段原文拆成各栏（整理时预填，用户看一眼再保存）。全在本机做，不问 AI。
   拆不准没关系：原文会留在一个平时隐藏的栏「原文」里（原文里有密码，不放进明着显示的备注）。 */
import type { Fields, SecretKind } from "./vault";

const URL_RE = /\bhttps?:\/\/[^\s，。；,;]+/i;
const HOST_RE = /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/\S*)?$/i;
const IP_RE = /^(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** 各家 key、token 的样子 */
const KEY_RE = /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})\b/;
const LABEL = {
  username: /(?:账号|帐号|账户|用户名?|登录名|user(?:name)?|login|account|邮箱|email|手机号?)\s*(?:[:：=]|是|为)?\s*(\S+)/i,
  password: /(?:密码|口令|pass(?:word)?|passwd|pwd)\s*(?:[:：=]|是|为)?\s*(\S+)/i,
  key: /(?:api[\s_-]?key|access[\s_-]?key|secret(?:[\s_-]?key)?|token|密钥|key)\s*(?:[:：=]|是|为)?\s*(\S+)/i,
  url: /(?:网址|地址|链接|url|host|主机|ip)\s*(?:[:：=]|是|为)?\s*(\S+)/i,
};

/** 一段话像不像账号密码（输入时用来提醒「存进密码库？」） */
export function looksLikeSecret(text: string) {
  const t = text.trim();
  if (t.length < 6 || t.length > 2000) return false;
  return KEY_RE.test(t) || LABEL.password.test(t) || /(?:api[\s_-]?key|token|密钥|secret)\s*(?:[:：=]|是|为)\s*\S{6,}/i.test(t);
}

const strip = (s: string) => s.replace(/^[，,。；;、"'“”‘’()（）[\]【】<>《》]+|[，,。；;、"'“”‘’()（）[\]【】<>《》]+$/g, "");
const hostOf = (u: string) => u.replace(/^https?:\/\//i, "").split(/[/?#]/)[0].replace(/^www\./i, "");

export function parseSecret(raw: string): Omit<Fields, "kind"> & { kind: SecretKind } {
  const text = raw.trim();
  const out: Omit<Fields, "kind"> & { kind: SecretKind } = { title: "", kind: "login", extra: [{ label: "原文", value: text, hidden: true }] };
  const used = new Set<string>();
  const take = (v?: string) => {
    const x = v ? strip(v) : "";
    if (x) used.add(x);
    return x || undefined;
  };

  // 1. 写明了「账号：」「密码：」的
  out.username = take(text.match(LABEL.username)?.[1]);
  out.password = take(text.match(LABEL.password)?.[1]);
  const key = text.match(KEY_RE)?.[0] ?? (out.password ? undefined : text.match(LABEL.key)?.[1]);
  if (key && !out.password) {
    out.password = take(key);
    out.kind = "apikey";
  }
  out.url = take(text.match(URL_RE)?.[0] ?? text.match(LABEL.url)?.[1]);

  // 2. 没写明的：按空白和中文逗号拆开，一个个认
  const tokens = text
    .split(/[\s，；;、]+/)
    .map(strip)
    .filter((t) => t && !used.has(t) && !/^(?:账号|帐号|账户|用户名?|登录名|密码|口令|网址|地址|链接|邮箱|手机号?|user(?:name)?|login|account|email|pass(?:word)?|passwd|pwd|url|host|token|key|secret|ip)[:：=]?$/i.test(t))
    // 「账号:abc」这种连在一起、上面已经认走的
    .filter((t) => ![...used].some((u) => t.endsWith(u) && /[:：=]/.test(t)));
  const rest: string[] = [];
  for (const t of tokens) {
    // root@10.0.0.5 这种是「用户@主机」，不是邮箱
    const at = t.match(/^([\w.-]+)@((?:\d{1,3}\.){3}\d{1,3}(?::\d+)?)$/);
    if (at && !out.username && !out.url) {
      out.username = at[1];
      out.url = at[2];
    } else if (!out.url && (HOST_RE.test(t) || IP_RE.test(t))) out.url = t;
    else if (!out.username && EMAIL_RE.test(t)) out.username = t;
    else rest.push(t);
  }
  // 带中文的、或者排在最前面的短词当名称
  const nameAt = rest.findIndex((t) => /[一-鿿]/.test(t));
  if (nameAt >= 0) out.title = rest.splice(nameAt, 1)[0];
  else if (rest.length >= 3 || (rest.length === 2 && out.username && !out.password)) out.title = rest.shift()!;
  else if (rest.length >= 1 && out.password && (out.username || out.kind === "apikey")) out.title = rest.shift()!;
  if (!out.username && rest.length >= 2) out.username = rest.shift();
  if (!out.password && rest.length >= 1) out.password = rest.pop();

  // 3. 种类和名称
  const host = out.url ? hostOf(out.url) : "";
  if (out.kind !== "apikey" && (IP_RE.test(host) || /:(?:22|3306|5432|6379|27017|3389|8006)\b/.test(host) || /ssh|root@|服务器|路由器|nas|数据库|交换机|树莓派/i.test(text))) out.kind = "server";
  // 「wifi密码」这种把栏名连在名称后面的
  out.title = out.title.replace(/的?(?:密码|口令|账号|帐号)$/, "") || out.title;
  if (!out.title) out.title = host || out.username || "";
  if (out.kind === "login" && !out.url && !out.username) out.kind = "other";
  return out;
}
