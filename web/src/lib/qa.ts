/* 划词问 AI：问答挂在原文旁边。
   位置记「原话 + 前后各 40 字」而不是字符位置，笔记后来插了内容也能找回；找不到时标「原文已删改」。 */
import type { Element, ElementContent, Root, RootContent, Text } from "hast";
import type { Item, Qa } from "./types";
import { typeName } from "./types";
import { entryTarget } from "./logic";

export const QA_CTX = 40;
/** 问答时笔记里的图片和附件放在工作目录的哪里（桌面版写进去，和 src-tauri 的 ASK_FILES 一致） */
export const ASK_FILES = ".xpanel/ask-files";

function commonTail(a: string, b: string) {
  let i = 0;
  while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}
function commonHead(a: string, b: string) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/** 在文字里找到这条问答的原文，返回起点（找不到 -1）；有多处时按前后文挑最像的 */
export function locateQuote(text: string, q: Pick<Qa, "quote" | "prefix" | "suffix">) {
  if (!q.quote) return -1;
  const hits: number[] = [];
  let i = -1;
  while ((i = text.indexOf(q.quote, i + 1)) >= 0) hits.push(i);
  if (!hits.length) return -1;
  let best = hits[0],
    score = -1;
  for (const h of hits) {
    const s = commonTail(text.slice(Math.max(0, h - QA_CTX), h), q.prefix || "") + commonHead(text.slice(h + q.quote.length, h + q.quote.length + QA_CTX), q.suffix || "");
    if (s > score) {
      score = s;
      best = h;
    }
  }
  return best;
}

/* ---- rehype 插件：渲染 Markdown 时给原文加 <mark>，给图片编号 ---- */

type Parent = Root | Element;
function textNodes(root: Parent) {
  const out: { node: Text; parent: Parent }[] = [];
  const walk = (p: Parent) => {
    for (const c of p.children as (RootContent | ElementContent)[]) {
      if (c.type === "text") out.push({ node: c, parent: p });
      else if (c.type === "element") walk(c);
    }
  };
  walk(root);
  return out;
}

/** 标出每条问答的原文；lost 里放找不到原文的问答 id */
export function rehypeQaMarks(opts: { qa: Qa[]; lost: Set<string> }) {
  return (tree: Root) => {
    const nodes = textNodes(tree);
    const text = nodes.map((n) => n.node.value).join("");
    const ranges: { s: number; e: number; id: string }[] = [];
    for (const q of opts.qa) {
      if (!q.quote) continue;
      const s = locateQuote(text, q);
      if (s < 0) opts.lost.add(q.id);
      else ranges.push({ s, e: s + q.quote.length, id: q.id });
    }
    if (!ranges.length) return;
    let pos = 0;
    for (const { node, parent } of nodes) {
      const a = pos,
        b = pos + node.value.length;
      pos = b;
      const hit = ranges.filter((r) => r.s < b && r.e > a);
      if (!hit.length) continue;
      // 按边界把这个文字节点切开，落在原文里的段落包上 <mark>
      const cuts = [...new Set([a, b, ...hit.flatMap((r) => [Math.max(a, r.s), Math.min(b, r.e)])])].sort((x, y) => x - y);
      const parts: ElementContent[] = [];
      for (let i = 0; i < cuts.length - 1; i++) {
        const value = node.value.slice(cuts[i] - a, cuts[i + 1] - a);
        if (!value) continue;
        const r = hit.find((r) => r.s <= cuts[i] && r.e >= cuts[i + 1]);
        parts.push(r ? { type: "element", tagName: "mark", properties: { className: ["qa-mark"], dataQa: r.id }, children: [{ type: "text", value }] } : { type: "text", value });
      }
      const idx = (parent.children as unknown[]).indexOf(node);
      (parent.children as unknown[]).splice(idx, 1, ...parts);
    }
  };
}

/** 图片按出现顺序编号（改大小时要知道改的是正文里第几张） */
export function rehypeImgIndex() {
  return (tree: Root) => {
    let n = 0;
    const walk = (p: Parent) => {
      for (const c of p.children as (RootContent | ElementContent)[]) {
        if (c.type !== "element") continue;
        if (c.tagName === "img") c.properties = { ...c.properties, dataIdx: n++ };
        walk(c);
      }
    };
    walk(tree);
  };
}

/* ---- 选中文字 → 原话和前后文 ---- */

function domTextNodes(root: HTMLElement) {
  const out: globalThis.Text[] = [];
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest("[data-qa-skip]") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  let n: Node | null;
  while ((n = w.nextNode())) out.push(n as globalThis.Text);
  return out;
}

export interface QaSel { itemId: string; quote: string; prefix: string; suffix: string }

/** 选区落在阅读区（[data-qa-host]）里时，算出原话和前后文 */
export function selectionContext(root: HTMLElement, range: Range, itemId: string): QaSel | null {
  let pos = 0,
    start = -1,
    end = -1;
  const nodes = domTextNodes(root);
  for (const n of nodes) {
    if (n === range.startContainer) start = pos + range.startOffset;
    if (n === range.endContainer) end = pos + range.endOffset;
    pos += n.nodeValue!.length;
  }
  // 选区端点落在元素上（比如三击选中整段）
  if (start < 0 || end < 0) {
    const all = nodes.map((n) => n.nodeValue).join("");
    const t = range.toString().trim();
    const i = t ? all.indexOf(t) : -1;
    if (i < 0) return null;
    start = i;
    end = i + t.length;
  }
  if (end <= start) return null;
  const text = nodes.map((n) => n.nodeValue).join("");
  const raw = text.slice(start, end);
  const quote = raw.trim();
  if (!quote || quote.length > 1500) return null;
  const s = start + raw.indexOf(quote);
  return { itemId, quote, prefix: text.slice(Math.max(0, s - QA_CTX), s), suffix: text.slice(s + quote.length, s + quote.length + QA_CTX) };
}

/* ---- 提问用的提示词 ---- */

/** 正文里引用的所有附件（图片和文件）的名字 */
export const assetRefs = (body?: string) => [...new Set([...String(body || "").matchAll(/\]\(asset:([A-Za-z0-9._-]+)\)/g)].map((m) => m[1]))];

/** 图片、附件换成工作目录里的相对路径（桌面版先把文件写到 ASK_FILES 下）；[[引用]] 换成标题 */
function forAi(body: string) {
  return body
    .replace(/!\[([^\]]*)\]\(asset:([^)\s]+)\)/g, (_m, alt: string, name: string) => {
      const a = alt.replace(/\|\d+$/, "");
      return `[图片${a ? "「" + a + "」" : ""}：${ASK_FILES}/${name}]`;
    })
    .replace(/\[([^\]]*)\]\(asset:([^)\s]+)\)/g, (_m, t: string, name: string) => `[附件「${t.replace(/^📎\s*/, "")}」：${ASK_FILES}/${name}]`)
    .replace(/\[([^\]]*)\]\(xpanel:item\/[^)]+\)/g, "《$1》");
}
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "\n…（后面省略）" : s);

export function buildAskPrompt(
  it: Item,
  ctx: { quote?: string; prefix?: string; suffix?: string },
  question: string,
  prev?: { q: string; a: string }[],
  related: { item: Item; label?: string }[] = [],
) {
  const kind = typeName(it.type);
  const body = forAi(String(it.body || ""));
  const L = [`你在帮我处理工作台里的一条「${kind}」，回答我关于它的问题。`, ``, `标题：${it.title || "(无标题)"}`];
  if (ctx.quote) L.push(``, `我选中的原文：`, ...ctx.quote.split("\n").map((l) => "> " + l), ``, `（前后文：…${ctx.prefix || ""}【${ctx.quote}】${ctx.suffix || ""}…）`);
  L.push(``, `正文：`, "```markdown", cut(body, 12000), "```");
  if (related.length) {
    L.push(``, `和它关联的 ${related.length} 条（标签说明了它们和这条的关系）：`);
    let budget = 40000;
    for (const r of related) {
      const x = r.item;
      const target = x.type === "link" ? entryTarget(x) : "";
      const text = cut(forAi(String(x.body || "")), Math.max(800, Math.min(8000, budget)));
      budget -= text.length;
      L.push(``, `### ${r.label ? "【" + r.label + "】" : ""}${x.title || "(无标题)"}（${typeName(x.type)}）`);
      if (target) L.push(`地址：${target}`);
      if (text.trim()) L.push("```markdown", text, "```");
    }
  }
  if (/\[(图片|附件)[^\]]*：\.xpanel\//.test(L.join("\n")))
    L.push(``, `上面提到的图片和附件（比如简历 PDF）已经放在当前工作目录的 ${ASK_FILES}/ 下，标着路径。问题和它们有关时，先用读文件的工具打开看清内容再回答，不要说看不到。`);
  if (prev && prev.length) {
    L.push(``, `之前的对话：`);
    prev.forEach((t) => L.push(`问：${t.q}`, `答：${t.a}`, ``));
  }
  L.push(``, `我的问题：${question}`, ``, `请用中文直接回答，Markdown 格式，准确、简洁，先给结论再解释；不确定的地方直说。不要修改任何文件。`);
  return L.join("\n");
}

/** 问答按原文顺序整理成一篇笔记 */
export function qaDigest(it: Item, text: string) {
  const list = (it.qa || []).map((q) => ({ q, pos: q.quote ? locateQuote(text, q) : -1 })).sort((a, b) => (a.pos < 0 ? 1e9 : a.pos) - (b.pos < 0 ? 1e9 : b.pos) || a.q.at - b.q.at);
  return [
    `> 笔记「${it.title || ""}」的问答整理，共 ${list.length} 条。`,
    ...list.map(({ q }, i) => {
      const [t0, ...rest] = q.turns || [];
      return [`## ${i + 1}. ${t0 ? t0.q : ""}`, q.quote ? q.quote.split("\n").map((l) => "> " + l).join("\n") : "> （针对整篇）", t0 ? t0.a : "", ...rest.map((t) => `**追问：** ${t.q}\n\n${t.a}`)].join("\n\n");
    }),
  ].join("\n\n");
}

/** 正文里的本地路径（D:\xx、\\NAS\share、/home/xx）包成可点击复制的小块；代码和链接里的不动 */
const RE_PATH = /\\\\[^\s\\<>"`|?*，。；]+(?:\\[^\s<>"`|?*，。；]*)*|\b[A-Za-z]:\\[^\s<>"`|?*，。；]*|(?<![\w/])\/(?:Volumes|mnt|home|Users|srv|data|opt|etc|var)\/[^\s<>"`，。；]*/g;
export function rehypePaths() {
  return (tree: Root) => {
    const walk = (p: Parent) => {
      const kids = p.children as (RootContent | ElementContent)[];
      for (let i = 0; i < kids.length; i++) {
        const c = kids[i];
        if (c.type === "element") {
          if (!["code", "pre", "a", "mark"].includes(c.tagName)) walk(c);
          continue;
        }
        if (c.type !== "text") continue;
        RE_PATH.lastIndex = 0;
        if (!RE_PATH.test(c.value)) continue;
        RE_PATH.lastIndex = 0;
        const parts: ElementContent[] = [];
        let last = 0;
        for (const m of c.value.matchAll(RE_PATH)) {
          const v = m[0].replace(/[.,:;)]+$/, "");
          if (m.index! > last) parts.push({ type: "text", value: c.value.slice(last, m.index) });
          parts.push({ type: "element", tagName: "span", properties: { className: ["xp-path"], dataCopy: v }, children: [{ type: "text", value: v }] });
          last = m.index! + v.length;
        }
        if (last < c.value.length) parts.push({ type: "text", value: c.value.slice(last) });
        kids.splice(i, 1, ...parts);
        i += parts.length - 1;
      }
    };
    walk(tree);
  };
}
