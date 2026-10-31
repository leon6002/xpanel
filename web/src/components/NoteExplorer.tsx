/* 笔记浏览器：分类是文件夹，笔记按 sub-notes 的层级排成树，位置固定，一屏能扫完。
   上面一个搜索框（只搜这一页），旁边的菜单换排序。拖动照旧：拖到另一篇上变成子笔记，
   拖到分类文件夹上归到那个分类，拖到空白处回到顶层。 */
import * as DM from "@radix-ui/react-dropdown-menu";
import { ArrowUpDown, Check, ChevronRight, Copy, FileText, Folder, FolderOpen, Pin, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { create } from "zustand";
import { copyText } from "../lib/api";
import { ls, useUi } from "../lib/store";
import { ago, noteTitle } from "../lib/logic";
import { buildTree, useClosedCats, useOpenNodes } from "../lib/tree";
import type { Item } from "../lib/types";
import { cx } from "../lib/cx";
import { useCatDnd, useNoteDnd } from "./Tree";

const COLL = new Intl.Collator("zh", { numeric: true, sensitivity: "base" });
const fullText = (it: Item) => [it.title, it.body].filter(Boolean).join("\n\n");

type Sort = "title" | "updated" | "created";
const SORTS: [Sort, string][] = [
  ["title", "按标题"],
  ["updated", "按修改时间"],
  ["created", "按创建时间"],
];
/** 排序记在本机；默认按标题，位置不会因为刚改过哪篇就跳来跳去 */
const useSort = create<{ sort: Sort; set: (s: Sort) => void }>((set) => ({
  sort: (SORTS.some(([k]) => k === ls.get("wb-note-sort")) ? ls.get("wb-note-sort") : "title") as Sort,
  set: (sort) => {
    ls.set("wb-note-sort", sort);
    set({ sort });
  },
}));

type Cmp = (a: Item, b: Item) => number;
const cmpBy = (sort: Sort): Cmp => (a, b) =>
  Number(!!b.pinned) - Number(!!a.pinned) ||
  (sort === "title" ? COLL.compare(noteTitle(a), noteTitle(b)) : sort === "created" ? (b.createdAt || 0) - (a.createdAt || 0) : (b.updatedAt || 0) - (a.updatedAt || 0));

/* ---------------------------------------------------------------- 分类文件夹 */

type CatNode = { path: string; name: string; depth: number; kids: CatNode[]; notes: Item[] };

/** 文件夹里有几篇：根笔记加上挂在它们下面的子笔记，和页面上能展开看到的条数对得上。
    seen 也防住外部改出来的父子环（见 lib/tree.ts）。 */
function catCount(node: CatNode, tree: ReturnType<typeof buildTree>, seen = new Set<string>()): number {
  let n = 0;
  const walk = (it: Item) => {
    if (seen.has(it.id)) return;
    seen.add(it.id);
    n++;
    tree.children(it.id).forEach(walk);
  };
  node.notes.forEach(walk);
  node.kids.forEach((k) => (n += catCount(k, tree, seen)));
  return n;
}

/** 只凭笔记的分类建文件夹：分类本身就是路径（工作/项目A），没笔记的分类不显示，免得空着 */
function buildCats(rootNotes: Item[]) {
  const byPath = new Map<string, CatNode>();
  const roots: CatNode[] = [];
  const ensure = (path: string): CatNode => {
    const hit = byPath.get(path);
    if (hit) return hit;
    const cut = path.lastIndexOf("/");
    const parentPath = cut < 0 ? "" : path.slice(0, cut);
    const parent = parentPath ? ensure(parentPath) : null;
    const node: CatNode = { path, name: path.slice(cut + 1), depth: parent ? parent.depth + 1 : 0, kids: [], notes: [] };
    byPath.set(path, node);
    (parent ? parent.kids : roots).push(node);
    return node;
  };
  for (const it of rootNotes) if (it.category) ensure(it.category).notes.push(it);
  const order = (node: CatNode) => {
    node.kids.sort((a, b) => COLL.compare(a.name, b.name));
    node.kids.forEach(order);
  };
  roots.sort((a, b) => COLL.compare(a.name, b.name));
  roots.forEach(order);
  return roots;
}

/* ---------------------------------------------------------------- 页面上的搜索 / 排序 */

export function NoteToolbar({ kind }: { kind: "note" | "rule" }) {
  const q = useUi((s) => s.q);
  const setQ = useUi((s) => s.setQ);
  const sort = useSort((s) => s.sort);
  const setSort = useSort((s) => s.set);
  const input = useRef<HTMLInputElement>(null);

  // 按 / 直接来搜索（和 Obsidian 一样）；在输入框、编辑器里打字时不算
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const a = document.activeElement as HTMLElement | null;
      if (a && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable)) return;
      if (document.querySelector('[role="dialog"]')) return;
      e.preventDefault();
      input.current?.focus();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);

  return (
    <div className="flex items-center gap-1.5 px-1">
      <label
        className="flex h-8 min-w-0 grow items-center gap-2 rounded-lg bg-surface-2 px-2.5 text-[13px] text-fg transition-colors focus-within:bg-surface-3"
        title="按 / 搜索"
      >
        <Search className="size-3.5 shrink-0 text-faint" />
        <input
          ref={input}
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.stopPropagation();
            if (q) setQ("");
            else e.currentTarget.blur();
          }}
          placeholder={kind === "note" ? "搜索笔记" : "搜索规范"}
          aria-label={kind === "note" ? "搜索笔记" : "搜索规范"}
          className="min-w-0 grow bg-transparent outline-none placeholder:text-faint [&::-webkit-search-cancel-button]:hidden"
        />
        {q && (
          <button type="button" aria-label="清空搜索" onClick={() => setQ("")} className="grid size-5 shrink-0 place-items-center rounded text-faint hover:text-fg">
            <X className="size-3.5" />
          </button>
        )}
      </label>
      <DM.Root>
        <DM.Trigger asChild>
          <button
            aria-label="排序"
            title={`排序：${SORTS.find(([k]) => k === sort)?.[1]}`}
            className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface-2 text-muted hover:bg-surface-3 hover:text-fg [&_svg]:size-4"
          >
            <ArrowUpDown />
          </button>
        </DM.Trigger>
        <DM.Portal>
          <DM.Content align="end" sideOffset={6} className="z-50 w-44 rounded-xl bg-surface p-1 shadow-3">
            {SORTS.map(([k, name]) => (
              <DM.Item
                key={k}
                onSelect={() => setSort(k)}
                className={cx(
                  "flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] outline-none data-[highlighted]:bg-surface-2",
                  sort === k ? "font-medium text-fg" : "text-fg-2",
                )}
              >
                <span className="grow">{name}</span>
                {sort === k && <Check className="size-3.5 text-accent" />}
              </DM.Item>
            ))}
          </DM.Content>
        </DM.Portal>
      </DM.Root>
    </div>
  );
}

/* ---------------------------------------------------------------- 一行笔记 */

function NoteRow({
  it,
  depth,
  sel,
  tree,
  cmp,
  crumb,
  filtering,
  seen,
}: {
  it: Item;
  depth: number;
  sel: string | null;
  tree: ReturnType<typeof buildTree>;
  cmp: Cmp;
  crumb?: string;
  filtering?: boolean;
  /** 上面几层（防止外部改出来的父子环无限展开） */
  seen?: Set<string>;
}) {
  const select = useUi((s) => s.select);
  const open = useOpenNodes((s) => !!s.open[it.id]);
  const toggle = useOpenNodes((s) => s.toggle);
  const dnd = useNoteDnd(it);
  const kids = filtering ? [] : tree.children(it.id).filter((k) => !seen?.has(k.id)).sort(cmp);
  const on = sel === it.id;
  return (
    <>
      <div
        {...dnd.props}
        data-item-id={it.id}
        onClick={() => select(it.id)}
        aria-current={on || undefined}
        title={`${noteTitle(it)}${it.category ? " · " + it.category.replace(/\//g, " / ") : ""}\n修改于 ${new Date(it.updatedAt || 0).toLocaleString()}`}
        className={cx(
          "group relative flex min-h-8 cursor-pointer items-center gap-1 rounded-lg pr-1.5 text-[13px] transition-colors",
          on ? "bg-surface-3 font-medium text-fg" : "text-fg-2 hover:bg-surface-2",
          dnd.over && "bg-accent-soft",
        )}
        style={{ paddingLeft: 4 + depth * 14 }}
      >
        {kids.length > 0 ? (
          <button
            aria-label={open ? "收起子笔记" : "展开子笔记"}
            onClick={(e) => {
              e.stopPropagation();
              toggle(it.id);
            }}
            className="grid size-5 shrink-0 place-items-center rounded text-faint hover:bg-surface-3 hover:text-fg"
          >
            <ChevronRight className={cx("size-3.5 transition-transform", open && "rotate-90")} />
          </button>
        ) : (
          <FileText className="mx-[3px] size-3.5 shrink-0 text-faint" />
        )}
        <div className="min-w-0 grow py-1">
          <span className="block truncate">
            {it.pinned && <Pin className="mr-1 inline size-3 text-accent align-[-1px]" />}
            {noteTitle(it)}
          </span>
          {crumb && <span className="block truncate text-[11px] text-faint">{crumb}</span>}
        </div>
        <span className="flex shrink-0 items-center gap-1">
          {kids.length > 0 && !open && <span className="text-[11px] text-faint">{kids.length}</span>}
          <span className="text-[11px] text-faint group-hover:hidden">{ago(it.updatedAt)}</span>
          <button
            aria-label="复制标题和正文"
            title="复制标题和正文"
            onClick={async (e) => {
              e.stopPropagation();
              useUi.getState().say((await copyText(fullText(it))) ? "已复制" : "复制失败");
            }}
            className="hidden size-6 place-items-center rounded text-faint hover:bg-surface-3 hover:text-fg group-hover:grid"
          >
            <Copy className="size-3.5" />
          </button>
        </span>
      </div>
      {open && kids.length > 0 && kids.map((k) => <NoteRow key={k.id} it={k} depth={depth + 1} sel={sel} tree={tree} cmp={cmp} seen={new Set([...(seen ?? []), it.id])} />)}
    </>
  );
}

/* ---------------------------------------------------------------- 一个分类文件夹 */

function CatRow({ node, sel, tree, cmp }: { node: CatNode; sel: string | null; tree: ReturnType<typeof buildTree>; cmp: Cmp }) {
  const closed = useClosedCats((s) => !!s.closed[node.path]);
  const toggle = useClosedCats((s) => s.toggle);
  const dnd = useCatDnd(node.path || null);
  const notes = node.notes.slice().sort(cmp);
  return (
    <>
      <div
        {...dnd.props}
        onClick={() => toggle(node.path, !closed)}
        aria-expanded={!closed}
        className={cx(
          "flex h-8 cursor-pointer items-center gap-1 rounded-lg pr-2 text-[13px] transition-colors",
          dnd.over ? "bg-accent-soft" : "text-fg-2 hover:bg-surface-2",
        )}
        style={{ paddingLeft: 4 + node.depth * 14 }}
      >
        <ChevronRight className={cx("size-3.5 shrink-0 text-faint transition-transform", !closed && "rotate-90")} />
        {closed ? <Folder className="size-4 shrink-0 text-muted" /> : <FolderOpen className="size-4 shrink-0 text-muted" />}
        <span className="min-w-0 grow truncate font-medium">{node.name}</span>
        <span className="shrink-0 text-[11px] text-faint">{catCount(node, tree)}</span>
      </div>
      {!closed && (
        <>
          {node.kids.map((k) => (
            <CatRow key={k.path} node={k} sel={sel} tree={tree} cmp={cmp} />
          ))}
          {notes.map((n) => (
            <NoteRow key={n.id} it={n} depth={node.depth + 1} sel={sel} tree={tree} cmp={cmp} />
          ))}
        </>
      )}
    </>
  );
}

/* ---------------------------------------------------------------- 整页的树 / 搜索结果 */

export function NoteExplorer({
  kind,
  all,
  matched,
  filtering,
  sel,
}: {
  kind: "note" | "rule";
  all: Item[];
  matched: Item[];
  filtering: boolean;
  sel: string | null;
}) {
  const sort = useSort((s) => s.sort);
  const cmp = useMemo(() => cmpBy(sort), [sort]);
  const tree = useMemo(() => buildTree(all), [all]);
  const roots = useMemo(() => buildCats(all.filter((x) => tree.isRoot(x))), [all, tree]);
  const uncategorized = useMemo(() => all.filter((x) => tree.isRoot(x) && !x.category).slice().sort(cmp), [all, tree, cmp]);

  // 选中的这条（比如从全局搜索、首页点过来）：把上面的父笔记和分类都展开，列表里找得到
  useEffect(() => {
    const it = sel ? tree.byId.get(sel) : undefined;
    if (!it) return;
    const open = useOpenNodes.getState().open;
    for (const a of tree.ancestors(it)) if (!open[a.id]) useOpenNodes.getState().toggle(a.id, true);
    const closed = useClosedCats.getState().closed;
    const segs = (it.category || "").split("/").filter(Boolean);
    let path = "";
    for (const s of segs) {
      path = path ? path + "/" + s : s;
      if (closed[path]) useClosedCats.getState().toggle(path, false);
    }
    if (!it.category && closed[""]) useClosedCats.getState().toggle("", false);
  }, [sel, tree]);

  if (filtering) {
    if (!matched.length) return <div className="px-1 py-6 text-center text-[13px] text-faint">没有匹配的内容</div>;
    // 搜索结果平铺，标题下面写着它在哪个分类、哪篇下面
    const rows = matched.slice().sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || (b.updatedAt || 0) - (a.updatedAt || 0));
    return (
      <div className="flex flex-col">
        {rows.map((it) => {
          const parts = [...(it.category ? it.category.split("/") : []), ...tree.ancestors(it).map(noteTitle)];
          return <NoteRow key={it.id} it={it} depth={0} sel={sel} tree={tree} cmp={cmp} crumb={parts.join(" / ") || undefined} filtering />;
        })}
      </div>
    );
  }

  if (!all.length) return <div className="px-1 py-6 text-center text-[13px] text-faint">{kind === "note" ? "还没有笔记" : "写下固定的做法和约定"}</div>;

  // 一条分类都没有时就按平铺的树显示，不套一个空的「未分类」文件夹
  const hasCats = roots.length > 0;
  const none: CatNode = { path: "", name: "未分类", depth: 0, kids: [], notes: uncategorized };
  return (
    <div className="flex flex-col">
      {hasCats ? (
        <>
          {roots.map((n) => (
            <CatRow key={n.path} node={n} sel={sel} tree={tree} cmp={cmp} />
          ))}
          {uncategorized.length > 0 && <CatRow node={none} sel={sel} tree={tree} cmp={cmp} />}
        </>
      ) : (
        uncategorized.map((n) => <NoteRow key={n.id} it={n} depth={0} sel={sel} tree={tree} cmp={cmp} />)
      )}
    </div>
  );
}
