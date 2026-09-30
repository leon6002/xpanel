/* 块编辑器：像飞书文档一样在排好版的内容上直接改。
   - 鼠标移到任意一块，左边出现「+」和手柄：+ 在下面插一块；手柄可以拖动排序，点开有复制、转换、上下移动、删除
   - 输入 / 插入标题、列表、待办、代码、表格、图片
   - 截图直接粘贴、文件拖进来；代码块右上角一键复制
   正文照旧存成 Markdown（只有真的改过才写回）。 */
import * as DM from "@radix-ui/react-dropdown-menu";
import CodeBlock from "@tiptap/extension-code-block";
import { DragHandle } from "@tiptap/extension-drag-handle-react";
import type { Node as PMNode } from "@tiptap/pm/model";
import { EditorContent, Extension, NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, useEditor, type Editor, type NodeViewProps, type Range } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import Suggestion from "@tiptap/suggestion";
import {
  ArrowDown,
  ArrowUp,
  Check,
  CheckSquare,
  Code2,
  Copy,
  GripVertical,
  Heading1,
  Heading2,
  Heading3,
  ImagePlus,
  List,
  ListOrdered,
  Minus,
  Pilcrow,
  Plus,
  Quote,
  Table2,
  Trash2,
  FileCode2,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { create } from "zustand";
import { copyText, errText, putAsset } from "../lib/api";
import { editorExtensions, tidyMarkdown, useGentleMarkdown, XImage } from "../lib/editor";
import { clipFiles, fileLabel, isImgFile } from "../lib/logic";
import { useUi } from "../lib/store";
import { cx } from "../lib/cx";
import { Lightbox, useAssetUrl, useOpenAsset } from "./Markdown";

const say = (t: string) => useUi.getState().say(t);

/* ---------------------------------------------------------------- 节点视图 */

const SIZES: [string, number][] = [
  ["小", 240],
  ["中", 480],
  ["大", 800],
  ["自动", 0],
];

function ImageView({ node, updateAttributes, selected }: NodeViewProps) {
  const src = String(node.attrs.src || "");
  const asset = useAssetUrl(src.startsWith("asset:") ? src.slice(6) : null);
  const url = src.startsWith("asset:") ? asset : src;
  const w = Number(node.attrs.width) || 0;
  const [big, setBig] = useState(false);
  return (
    <NodeViewWrapper className="group/img relative my-2 block w-fit max-w-full" data-drag-handle>
      {url ? (
        <img src={url} alt={node.attrs.alt || ""} style={w ? { width: w } : undefined} className={cx("max-w-full rounded-[10px]", selected && "ring-2 ring-accent")} onDoubleClick={() => setBig(true)} />
      ) : (
        <span className="inline-block rounded-lg bg-surface-2 px-2 py-1 text-xs text-faint">{node.attrs.alt || "图片"}</span>
      )}
      <span contentEditable={false} className="absolute top-2 right-2 hidden gap-0.5 rounded-lg bg-surface/95 p-0.5 text-xs shadow-2 group-hover/img:flex">
        {SIZES.map(([n, v]) => (
          <button
            key={n}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => updateAttributes({ width: v || null })}
            className={cx("rounded-md px-2 py-0.5", v === w ? "bg-ink text-on-ink" : "text-fg-2 hover:bg-surface-3")}
          >
            {n}
          </button>
        ))}
      </span>
      {big && url && <Lightbox src={url} onClose={() => setBig(false)} />}
    </NodeViewWrapper>
  );
}

function CodeView({ node }: NodeViewProps) {
  const [done, setDone] = useState(false);
  return (
    <NodeViewWrapper className="group/code relative">
      <span contentEditable={false} className="absolute top-2 right-2 flex items-center gap-1 text-xs select-none">
        {node.attrs.language && <span className="text-faint">{node.attrs.language}</span>}
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={async () => {
            if (await copyText(node.textContent)) {
              setDone(true);
              setTimeout(() => setDone(false), 1200);
            }
          }}
          className="flex items-center gap-1 rounded-md bg-surface px-2 py-0.5 text-muted opacity-0 shadow-1 group-hover/code:opacity-100 hover:text-fg [&_svg]:size-3.5"
        >
          {done ? <Check /> : <Copy />}
          {done ? "已复制" : "复制"}
        </button>
      </span>
      <pre>
        <NodeViewContent<"code"> as="code" />
      </pre>
    </NodeViewWrapper>
  );
}

const XImageView = XImage.extend({ addNodeView: () => ReactNodeViewRenderer(ImageView) });
const XCodeBlock = CodeBlock.extend({ addNodeView: () => ReactNodeViewRenderer(CodeView) });

/* ---------------------------------------------------------------- 斜杠菜单 */

interface Cmd {
  key: string;
  name: string;
  hint?: string;
  icon: typeof Pilcrow;
  run: (e: Editor) => void;
}
const pickImage = (editor: Editor) => {
  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept = "image/*";
  inp.multiple = true;
  inp.onchange = () => insertFiles(editor, [...(inp.files || [])]);
  inp.click();
};
const BLOCKS: Cmd[] = [
  { key: "p text zw 正文", name: "正文", icon: Pilcrow, run: (e) => e.chain().focus().setParagraph().run() },
  { key: "h1 bt 标题", name: "一级标题", hint: "#", icon: Heading1, run: (e) => e.chain().focus().setHeading({ level: 1 }).run() },
  { key: "h2 bt 标题", name: "二级标题", hint: "##", icon: Heading2, run: (e) => e.chain().focus().setHeading({ level: 2 }).run() },
  { key: "h3 bt 标题", name: "三级标题", hint: "###", icon: Heading3, run: (e) => e.chain().focus().setHeading({ level: 3 }).run() },
  { key: "ul lb 列表 无序", name: "无序列表", hint: "-", icon: List, run: (e) => e.chain().focus().toggleBulletList().run() },
  { key: "ol lb 列表 有序 编号", name: "有序列表", hint: "1.", icon: ListOrdered, run: (e) => e.chain().focus().toggleOrderedList().run() },
  { key: "todo db 待办 任务", name: "待办", hint: "[]", icon: CheckSquare, run: (e) => e.chain().focus().toggleTaskList().run() },
  { key: "quote yy 引用", name: "引用", hint: ">", icon: Quote, run: (e) => e.chain().focus().toggleBlockquote().run() },
  { key: "code dm 代码", name: "代码块", hint: "```", icon: Code2, run: (e) => e.chain().focus().toggleCodeBlock().run() },
  { key: "table bg 表格", name: "表格", icon: Table2, run: (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  { key: "hr fgx 分割线", name: "分割线", hint: "---", icon: Minus, run: (e) => e.chain().focus().setHorizontalRule().run() },
  { key: "img tp 图片 截图", name: "图片", icon: ImagePlus, run: (e) => pickImage(e) },
];
/** 在块菜单里「转换为」能用的 */
const TURN = BLOCKS.filter((b) => !["table", "hr", "img"].some((k) => b.key.startsWith(k)));

const useSlash = create<{ open: boolean; items: Cmd[]; index: number; rect: DOMRect | null; pick: ((c: Cmd) => void) | null }>(() => ({
  open: false,
  items: [],
  index: 0,
  rect: null,
  pick: null,
}));

/* 鼠标所在的块铺一层浅底色，看得出一块是从哪到哪（手柄对着的就是这一块） */
const hoverKey = new PluginKey<number | null>("xp-hover");
const BlockHover = Extension.create({
  name: "xpBlockHover",
  addProseMirrorPlugins() {
    return [
      new Plugin<number | null>({
        key: hoverKey,
        state: {
          init: () => null,
          apply(tr, pos) {
            const m = tr.getMeta(hoverKey);
            if (m !== undefined) return m as number | null;
            return pos == null ? null : tr.mapping.map(pos);
          },
        },
        props: {
          decorations(state) {
            const pos = hoverKey.getState(state);
            if (pos == null) return null;
            const node = state.doc.nodeAt(pos);
            if (!node) return null;
            return DecorationSet.create(state.doc, [Decoration.node(pos, pos + node.nodeSize, { class: "xp-hover" })]);
          },
        },
      }),
    ];
  },
});
const setHover = (editor: Editor, pos: number | null) => {
  if (editor.isDestroyed || hoverKey.getState(editor.state) === pos) return;
  editor.view.dispatch(editor.state.tr.setMeta(hoverKey, pos).setMeta("addToHistory", false));
};

const SlashCommand = Extension.create({
  name: "slash",
  addProseMirrorPlugins() {
    return [
      Suggestion<Cmd, Cmd>({
        editor: this.editor,
        char: "/",
        allowSpaces: false,
        items: ({ query }) => {
          const q = query.toLowerCase();
          return BLOCKS.filter((b) => !q || b.key.includes(q) || b.name.includes(q));
        },
        command: ({ editor, range, props }) => {
          editor.chain().focus().deleteRange(range as Range).run();
          props.run(editor);
        },
        render: () => ({
          onStart: (p) => useSlash.setState({ open: true, items: p.items, index: 0, rect: p.clientRect?.() ?? null, pick: (c) => p.command(c) }),
          onUpdate: (p) => useSlash.setState({ items: p.items, index: 0, rect: p.clientRect?.() ?? null, pick: (c) => p.command(c) }),
          onKeyDown: ({ event }) => {
            const s = useSlash.getState();
            if (!s.open || !s.items.length) return false;
            if (event.key === "ArrowDown") return useSlash.setState({ index: (s.index + 1) % s.items.length }), true;
            if (event.key === "ArrowUp") return useSlash.setState({ index: (s.index - 1 + s.items.length) % s.items.length }), true;
            if (event.key === "Enter") return s.pick?.(s.items[s.index]), true;
            if (event.key === "Escape") return useSlash.setState({ open: false }), true;
            return false;
          },
          onExit: () => useSlash.setState({ open: false, pick: null }),
        }),
      }),
    ];
  },
});

function SlashMenu() {
  const { open, items, index, rect, pick } = useSlash();
  if (!open || !rect || !items.length) return null;
  const below = rect.bottom + 320 < window.innerHeight;
  return (
    <div
      className="fixed z-50 w-60 overflow-hidden rounded-xl bg-surface p-1 shadow-3"
      style={{ left: Math.min(rect.left, window.innerWidth - 250), ...(below ? { top: rect.bottom + 6 } : { bottom: window.innerHeight - rect.top + 6 }) }}
      onMouseDown={(e) => e.preventDefault()}
    >
      {items.map((c, i) => (
        <button
          key={c.key}
          onClick={() => pick?.(c)}
          onMouseEnter={() => useSlash.setState({ index: i })}
          className={cx("flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13.5px] [&_svg]:size-4", i === index ? "bg-surface-2 text-fg" : "text-fg-2")}
        >
          <c.icon className="text-muted" />
          <span className="grow">{c.name}</span>
          {c.hint && <span className="font-mono text-[11px] text-faint">{c.hint}</span>}
        </button>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- 附件 */

async function insertFiles(editor: Editor, files: File[], at?: number) {
  for (const f of files) {
    try {
      const name = await putAsset(f);
      const content = isImgFile(f)
        ? { type: "image", attrs: { src: "asset:" + name, alt: fileLabel(f) } }
        : { type: "paragraph", content: [{ type: "text", text: "📎 " + fileLabel(f), marks: [{ type: "link", attrs: { href: "asset:" + name } }] }] };
      if (at != null) editor.chain().insertContentAt(at, content).run();
      else editor.chain().focus().insertContent(content).run();
      say(isImgFile(f) ? "截图已保存并插入" : "文件已保存并附上");
    } catch (e) {
      say("保存失败：" + errText(e));
    }
  }
}

/* ---------------------------------------------------------------- 块手柄 */

function MenuItem({ icon: Icon, children, onSelect, danger }: { icon: typeof Copy; children: ReactNode; onSelect: () => void; danger?: boolean }) {
  return (
    <DM.Item
      onSelect={onSelect}
      className={cx(
        "flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] outline-none data-[highlighted]:bg-surface-2 [&_svg]:size-4",
        danger ? "text-danger" : "text-fg-2",
      )}
    >
      <Icon className={danger ? "" : "text-muted"} />
      {children}
    </DM.Item>
  );
}

function BlockHandle({ editor }: { editor: Editor }) {
  const cur = useRef<{ node: PMNode | null; pos: number }>({ node: null, pos: -1 });
  const [menu, setMenu] = useState(false);
  const target = () => {
    const { node, pos } = cur.current;
    return node && pos >= 0 ? { node, pos } : null;
  };
  const md = (node: PMNode) => tidyMarkdown((editor.markdown as unknown as { serialize: (j: unknown) => string }).serialize({ type: "doc", content: [node.toJSON()] }));
  const move = (dir: -1 | 1) => {
    const t = target();
    if (!t) return;
    const $pos = editor.state.doc.resolve(t.pos);
    const idx = $pos.index();
    const parent = $pos.parent;
    const sib = dir < 0 ? (idx > 0 ? parent.child(idx - 1) : null) : idx + 1 < parent.childCount ? parent.child(idx + 1) : null;
    if (!sib) return;
    const tr = editor.state.tr.delete(t.pos, t.pos + t.node.nodeSize);
    tr.insert(dir < 0 ? t.pos - sib.nodeSize : t.pos + sib.nodeSize, t.node);
    editor.view.dispatch(tr);
  };
  const turn = (c: Cmd) => {
    const t = target();
    if (!t) return;
    editor.chain().focus().setTextSelection(t.pos + 1).run();
    c.run(editor);
  };
  const addBelow = () => {
    const t = target();
    const at = t ? t.pos + t.node.nodeSize : editor.state.doc.content.size;
    editor.chain().insertContentAt(at, { type: "paragraph", content: [{ type: "text", text: "/" }] }).setTextSelection(at + 2).focus().run();
  };

  return (
    <DragHandle
      editor={editor}
      onNodeChange={({ node, pos }) => {
        if (menu) return;
        cur.current = { node, pos };
        setHover(editor, node ? pos : null);
      }}
      computePositionConfig={{ placement: "left-start", strategy: "absolute" }}
    >
      <div className="flex items-center pr-1.5 text-faint">
        <button title="在下面插入（也可以输入 /）" onClick={addBelow} className="grid size-6 place-items-center rounded-md hover:bg-surface-2 hover:text-fg [&_svg]:size-4">
          <Plus />
        </button>
        <DM.Root open={menu} onOpenChange={setMenu}>
          <DM.Trigger asChild>
            <button title="拖动排序，点击打开菜单" className="grid h-6 w-5 cursor-grab place-items-center rounded-md hover:bg-surface-2 hover:text-fg [&_svg]:size-4">
              <GripVertical />
            </button>
          </DM.Trigger>
          <DM.Portal>
            <DM.Content side="left" align="start" sideOffset={6} className="z-50 w-52 rounded-xl bg-surface p-1 shadow-3">
              <MenuItem
                icon={Copy}
                onSelect={async () => {
                  const t = target();
                  if (t) say((await copyText(t.node.type.name === "codeBlock" ? t.node.textContent : t.node.textContent.trim() && !["table", "bulletList", "orderedList", "taskList"].includes(t.node.type.name) ? t.node.textContent : md(t.node))) ? "已复制" : "复制失败");
                }}
              >
                复制
              </MenuItem>
              <MenuItem
                icon={FileCode2}
                onSelect={async () => {
                  const t = target();
                  if (t) say((await copyText(md(t.node))) ? "已复制 Markdown" : "复制失败");
                }}
              >
                复制为 Markdown
              </MenuItem>
              <DM.Sub>
                <DM.SubTrigger className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] text-fg-2 outline-none data-[highlighted]:bg-surface-2 data-[state=open]:bg-surface-2 [&_svg]:size-4">
                  <Pilcrow className="text-muted" />
                  转换为
                </DM.SubTrigger>
                <DM.Portal>
                  <DM.SubContent sideOffset={6} className="z-50 w-44 rounded-xl bg-surface p-1 shadow-3">
                    {TURN.map((c) => (
                      <MenuItem key={c.key} icon={c.icon} onSelect={() => turn(c)}>
                        {c.name}
                      </MenuItem>
                    ))}
                  </DM.SubContent>
                </DM.Portal>
              </DM.Sub>
              <MenuItem icon={ArrowUp} onSelect={() => move(-1)}>
                上移
              </MenuItem>
              <MenuItem icon={ArrowDown} onSelect={() => move(1)}>
                下移
              </MenuItem>
              <DM.Separator className="my-1 h-px bg-line-soft" />
              <MenuItem
                icon={Trash2}
                danger
                onSelect={() => {
                  const t = target();
                  if (t) editor.chain().focus().deleteRange({ from: t.pos, to: t.pos + t.node.nodeSize }).run();
                }}
              >
                删除
              </MenuItem>
            </DM.Content>
          </DM.Portal>
        </DM.Root>
      </div>
    </DragHandle>
  );
}

/* ---------------------------------------------------------------- 编辑器 */

/** value：初始 Markdown；onChange：内容真的改过时回调（已防抖）；api：父组件保存前取最新 Markdown */
export function BlockEditor({
  value,
  onChange,
  api,
  itemId,
}: {
  value: string;
  onChange: (md: string) => void;
  api: React.MutableRefObject<(() => string | null) | null>;
  itemId: string;
}) {
  const dirty = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const openAsset = useOpenAsset();
  const editor = useEditor(
    {
      extensions: editorExtensions([SlashCommand, BlockHover], { image: XImageView as never, codeBlock: XCodeBlock }),
      content: value,
      contentType: "markdown",
      immediatelyRender: true,
      shouldRerenderOnTransaction: false,
      editorProps: {
        attributes: { class: "xp-editor prose-x outline-none", spellcheck: "false", "data-qa-host": itemId },
        handlePaste: (_view, e) => {
          const files = clipFiles(e.clipboardData);
          if (!files.length || !editor) return false;
          e.preventDefault();
          insertFiles(editor, files);
          return true;
        },
        handleDrop: (view, e) => {
          const files = clipFiles(e.dataTransfer);
          if (!files.length || !editor) return false;
          e.preventDefault();
          const at = view.posAtCoords({ left: e.clientX, top: e.clientY });
          insertFiles(editor, files, at?.pos);
          return true;
        },
        handleClickOn: (_view, _pos, node, _npos, e) => {
          // Ctrl / ⌘ + 点击链接：打开
          const a = (e.target as HTMLElement).closest("a");
          if (a && (e.ctrlKey || e.metaKey)) {
            const h = a.getAttribute("href") || "";
            if (h.startsWith("asset:")) openAsset(h.slice(6));
            else window.open(h, "_blank");
            return true;
          }
          void node;
          return false;
        },
      },
      onUpdate: ({ editor: ed, transaction }) => {
        if (!transaction.docChanged) return;
        dirty.current = true;
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => onChange(tidyMarkdown(ed.getMarkdown())), 400);
      },
    },
    [itemId],
  );
  useGentleMarkdown(editor);
  useEffect(() => {
    api.current = () => {
      if (!dirty.current || !editor || editor.isDestroyed) return null;
      window.clearTimeout(timer.current);
      return tidyMarkdown(editor.getMarkdown());
    };
    return () => {
      // 卸载前把最后的改动交出去
      if (dirty.current && editor && !editor.isDestroyed) onChange(tidyMarkdown(editor.getMarkdown()));
      window.clearTimeout(timer.current);
      api.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);
  if (!editor) return null;
  return (
    <div className="relative flex-[1_0_auto] pl-12" onMouseLeave={() => !document.querySelector("[data-radix-menu-content]") && setHover(editor, null)} onClick={(e) => e.target === e.currentTarget && editor.chain().focus("end").run()}>
      <BlockHandle editor={editor} />
      <EditorContent editor={editor} className="pb-8" />
      <SlashMenu />
    </div>
  );
}
