/* 块编辑器（TipTap）的扩展：正文仍然存成 Markdown，编辑时所见即所得。
   和阅读页保持一致：单个换行就是换行（marked 的 breaks），图片说明末尾的 |480 是宽度，附件写成 asset:名字。 */
import type { AnyExtension } from "@tiptap/core";
import HardBreak from "@tiptap/extension-hard-break";
import Image from "@tiptap/extension-image";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import { Placeholder } from "@tiptap/extensions";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";

/** 图片：说明里的 |480 拆成宽度；src 保持 asset:名字，显示时再换成真地址（见 BlockEditor 的节点视图） */
export const XImage = Image.extend({
  inline: false,
  group: "block",
  addAttributes() {
    return {
      ...this.parent?.(),
      width: { default: null },
    };
  },
  parseMarkdown: (token, helpers) => {
    const m = String(token.text || "").match(/^(.*?)\|(\d{2,4})$/);
    return helpers.createNode("image", { src: token.href, title: token.title || null, alt: m ? m[1] : token.text || "", width: m ? +m[2] : null }) as never;
  },
  renderMarkdown: (node) => {
    const a = node.attrs || {};
    const alt = String(a.alt || "") + (a.width ? "|" + Math.round(Number(a.width)) : "");
    return a.title ? `![${alt}](${a.src} "${a.title}")` : `![${alt}](${a.src})`;
  },
});

/** 换行存成真正的换行（阅读页按「单个换行就换行」显示），不用行尾两个空格 */
const XHardBreak = HardBreak.extend({ renderMarkdown: () => "\n" });

/** views：带界面的节点（图片、代码块）换成 React 版本；extra：斜杠菜单等 */
export function editorExtensions(extra: AnyExtension[] = [], views: { image?: AnyExtension; codeBlock?: AnyExtension } = {}): AnyExtension[] {
  return [
    StarterKit.configure({
      hardBreak: false,
      ...(views.codeBlock ? { codeBlock: false } : {}),
      // asset:（附件）和 xpanel:item/ID（引用另一条）也是合法链接
      link: {
        openOnClick: false,
        autolink: true,
        defaultProtocol: "https",
        isAllowedUri: (url, ctx) => /^(asset|xpanel):/i.test(url) || ctx.defaultValidate(url),
      },
      heading: { levels: [1, 2, 3, 4] },
    }),
    XHardBreak,
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: false } }),
    views.image ?? XImage,
    ...(views.codeBlock ? [views.codeBlock] : []),
    Placeholder.configure({
      placeholder: ({ node }) => (node.type.name === "heading" ? "标题" : "输入文字，或按 / 插入标题、列表、待办、代码、表格…"),
      showOnlyCurrent: true,
    }),
    Markdown.configure({ markedOptions: { gfm: true, breaks: true } }),
    ...extra,
  ];
}


/* ---- 写回 Markdown：少转义，尽量保持原样 ----
   TipTap 默认会把 \ > _ [ 等全部转义（D:\codes 变成 D:\\codes，> 变成 &gt;），渲染结果一样但原文难看、AI 读着也费劲。
   这里只转义真的会被误读的：行首的 # - + 1. >、成对的 * ` ~~、像链接的 [、词边界上的 _、看起来像 HTML 标签的 <。 */
export function gentleEscape(text: string) {
  let s = text
    .replace(/\\(?=[!-/:-@[-`{-~])/g, "\\\\") // 反斜杠只在后面是标点时才会被当成转义
    .replace(/&(?=#?[a-z0-9]+;)/gi, "&amp;")
    .replace(/<(?=[a-z/!?])/gi, "&lt;")
    .replace(/[*`]/g, "\\$&")
    .replace(/~~/g, "\\~\\~")
    .replace(/\[(?=[^\]]*\](\(|\[))/g, "\\[")
    .replace(/(^|[^\p{L}\p{N}])_|_(?=[^\p{L}\p{N}]|$)/gu, (m) => m.replace("_", "\\_"));
  // 行首会变成标题、列表、引用的写法
  s = s.replace(/^(#{1,6}\s|[-+]\s|\d+[.)]\s|>)/, (m) => "\\" + m);
  return s;
}

type Manager = { codeTypes: Set<string>; encodeTextForMarkdown: (text: string, node: { marks?: unknown[] }, parent?: { type?: string }) => string };
export function useGentleMarkdown(editor: { markdown?: unknown } | null) {
  const m = editor?.markdown as Manager | undefined;
  if (!m || (m as unknown as { __gentle?: boolean }).__gentle) return;
  (m as unknown as { __gentle?: boolean }).__gentle = true;
  m.encodeTextForMarkdown = function (text, node, parent) {
    const inCode =
      (parent?.type != null && this.codeTypes.has(parent.type)) ||
      (node.marks || []).some((x) => this.codeTypes.has(typeof x === "string" ? x : (x as { type: string }).type));
    return inCode ? text : gentleEscape(text);
  };
}

/** 整理输出：代码块以外的连续空行压成一个，去掉结尾空行 */
export function tidyMarkdown(md: string) {
  const parts = md.split(/(^```[\s\S]*?^```)/m);
  return parts
    .map((p, i) => (i % 2 ? p : p.replace(/\n{3,}/g, "\n\n")))
    .join("")
    .replace(/\s+$/, "");
}
