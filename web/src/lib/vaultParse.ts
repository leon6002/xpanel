/* 把快速记下的一段原文拆成各栏（整理时预填，用户看一眼再保存）。全在本机做，不问 AI。
   拆不准没关系：原文会留在一个平时隐藏的栏「原文」里（原文里有密码，不放进明着显示的备注）。 */
import { composeTitle, detectPlatform, mentionsBank } from "./platforms";
import type { Fields, SecretKind } from "./vault";

const URL_RE = /\bhttps?:\/\/[^\s，。；,;]+/i;
const HOST_RE = /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/\S*)?$/i;
const IP_RE = /^(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** 各家 key、token 的样子 */
const KEY_RE = /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})\b/;
const LABEL = {
  username: /(?:账号|帐号|账户|用户名?|登录名|user(?:name)?|login|account|邮箱|email|手机号码?|手机(?=\s*[:：=]))\s*(?:[:：=]|是|为)?\s*(\S+)/i,
  password: /(?<!交易|取款|支付|查询)(?:密码|口令|pass(?:word)?|passwd|pwd)\s*(?:[:：=]|是|为)?\s*(\S+)/i,
  key: /(?:api[\s_-]?key|access[\s_-]?key|secret(?:[\s_-]?key)?|token|密钥|key)\s*(?:[:：=]|是|为)?\s*(\S+)/i,
  url: /(?:网址|地址|链接|url|host|主机|ip)\s*(?:[:：=]|是|为)?\s*(\S+)/i,
};

/** 一段话像不像账号密码（输入时用来提醒「存进密码库？」） */
export function looksLikeSecret(text: string) {
  const t = text.trim();
  if (t.length < 6 || t.length > 2000) return false;
  return KEY_RE.test(t) || LABEL.password.test(t) || (!!cardIn(t) && (BANK_RE.test(t) || mentionsBank(t) || /cvv|有效期/i.test(t))) || /(?:api[\s_-]?key|token|密钥|secret)\s*(?:[:：=]|是|为)\s*\S{6,}/i.test(t);
}

/** 提到了银行：「银行」「信用卡」，或者常见银行的简称 */
const BANK_RE = /银行|信用卡|储蓄卡|借记卡|网银|卡号|[工农中建交招]行|浦发|中信|民生|光大|兴业|平安|广发|华夏|邮储|信用社|农商/;

/** 银行卡号：13–19 位数字，过得了校验位；话里提到了银行的，15 位以上就算（免得抄错一位就认不出来） */
function cardIn(text: string) {
  const loose = BANK_RE.test(text) || mentionsBank(text);
  for (const m of text.matchAll(/(?<![\d.])(?:\d{13,19}|\d{4}(?:[ -]\d{4}){2,3}(?:[ -]\d{1,3})?)(?![\d.])/g)) {
    const d = m[0].replace(/\D/g, "");
    let sum = 0;
    for (let i = 0; i < d.length; i++) {
      let n = +d[d.length - 1 - i];
      if (i % 2) n = n * 2 > 9 ? n * 2 - 9 : n * 2;
      sum += n;
    }
    if (sum % 10 === 0 || (loose && d.length >= 15)) return { raw: m[0], digits: d };
  }
  return null;
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

  // 0. 银行卡：有卡号，或者提到了银行、信用卡
  const card = cardIn(text);
  const bank = !!card || BANK_RE.test(text) || mentionsBank(text);
  if (bank) {
    out.kind = "bank";
    const cvv = text.match(/(?:cvv2?|cvc|安全码|后三位)\s*(?:[:：=]|是|为)?\s*(\d{3,4})\b/i)?.[1];
    const exp = text.match(/(?:有效期|到期|exp(?:iry)?)\s*(?:[:：=]|是|为|至)?\s*(\d{2}\s*[/-]\s*\d{2,4})/i)?.[1] ?? text.match(/(?<!\d)(0[1-9]|1[0-2])\/(\d{2})(?!\d)/)?.[0];
    const pin = text.match(/(?:交易密码|取款密码|支付密码|查询密码)\s*(?:[:：=]|是|为)?\s*(\S+)/)?.[1];
    out.sub = /信用卡|credit/i.test(text) || cvv || exp ? "credit" : "mobile";
    if (card) {
      out.card = card.digits;
      used.add(card.raw);
      for (const part of card.raw.split(/[ -]/)) used.add(part);
    }
    out.cvv = take(cvv);
    out.expiry = take(exp?.replace(/\s+/g, ""));
    out.pin = take(pin);
  }

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
    .filter((t) => t && !used.has(t) && !/^(?:账号|帐号|账户|用户名?|登录名|密码|口令|网址|地址|链接|邮箱|手机号?|卡号|有效期|安全码|交易密码|取款密码|支付密码|查询密码|cvv2?|cvc|user(?:name)?|login|account|email|pass(?:word)?|passwd|pwd|url|host|token|key|secret|ip)[:：=]?$/i.test(t))
    // 「账号:abc」这种连在一起、上面已经认走的
    .filter((t) => ![...used].some((u) => t.endsWith(u) && /[:：=]/.test(t)))
    // 「信用卡」「手机银行」这种只是说明是哪一种，不是名称也不是密码
    .filter((t) => !(bank && /^(?:信用卡|储蓄卡|借记卡|银行卡|手机银行|网银|网上银行)$/.test(t)));
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
  // 写了平台名字的（apple、谷歌、招行）拿它当名称；否则带中文的、或者排在最前面的短词当名称
  const platAt = rest.findIndex((t) => !!detectPlatform({ title: t }, bank));
  const nameAt = platAt >= 0 ? platAt : rest.findIndex((t) => /[一-鿿]/.test(t));
  if (nameAt >= 0) out.title = rest.splice(nameAt, 1)[0];
  else if (rest.length >= 3 || (rest.length === 2 && out.username && !out.password)) out.title = rest.shift()!;
  else if (rest.length >= 1 && out.password && (out.username || out.kind === "apikey")) out.title = rest.shift()!;
  // 信用卡一般没有登录账号密码：剩下的词不硬猜，留在原文里；单独的三位数当安全码
  if (out.sub === "credit") {
    const at = rest.findIndex((t) => /^\d{3}$/.test(t));
    if (!out.cvv && at >= 0) out.cvv = rest.splice(at, 1)[0];
  } else {
    if (!out.username && rest.length >= 2) out.username = rest.shift();
    if (!out.password && rest.length >= 1) out.password = rest.pop();
  }

  // 3. 种类和名称
  const host = out.url ? hostOf(out.url) : "";
  if (out.kind !== "apikey" && out.kind !== "bank" && (IP_RE.test(host) || /:(?:22|3306|5432|6379|27017|3389|8006)\b/.test(host) || /ssh|root@|服务器|路由器|nas|数据库|交换机|树莓派/i.test(text))) out.kind = "server";
  // 「wifi密码」这种把栏名连在名称后面的
  out.title = out.title.replace(/的?(?:密码|口令|账号|帐号|卡号)$/, "") || out.title;
  // 平台：从名称、网址认；都没写名称的，看邮箱是哪家的（xxx@icloud.com → Apple）
  const named = !!out.title;
  const p = out.kind === "server" ? undefined : detectPlatform({ title: out.title, url: out.url, email: named ? undefined : out.username }, bank);
  if (p) {
    out.platform = p.id;
    if (!named || [p.name, ...p.aliases].some((a) => a.toLowerCase() === out.title.toLowerCase())) out.title = p.name;
    if (out.kind === "login" && !out.url && p.url) out.url = p.url;
    // 剩下的一个词当用途（「苹果 美区 xxx 密码」里的「美区」）
    if (rest.length === 1 && rest[0].length <= 8) out.label = rest[0];
  }
  if (!out.title) out.title = host || out.username || "";
  if (out.sub === "credit" && out.title && !/卡/.test(out.title)) out.title += "信用卡";
  if (out.kind === "login" && !out.url && !out.username) out.kind = "other";
  out.title = composeTitle(out.title, out.label);
  return out;
}
