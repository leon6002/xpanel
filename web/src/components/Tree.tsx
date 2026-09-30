/* 子笔记：阅读区顶上的路径、正文下面的子笔记列表、「移动到…」对话框、列表里的层级和拖动 */
import { ChevronRight, FileText, Plus } from "lucide-react";
import { useMemo, useState, type DragEvent } from "react";
import { qc, useAppState } from "../lib/data";
import { Dialog, openDialog } from "../lib/dialog";
import { ago, noteTitle, plain } from "../lib/logic";
import { useUi } from "../lib/store";
import { addChild, buildTree, moveUnder, useOpenNodes } from "../lib/tree";
import type { Item, State } from "../lib/types";
import { cx } from "../lib/cx";
import { Button, inputCls } from "./ui";

const say = (t: string) => useUi.getState().say(t);
const allItems = () => qc.getQueryData<State>(["state"])?.items ?? [];
export type OpenFn = (id: string, edit?: boolean) => void;

function useTree() {
  const items = useAppState().data?.items;
  return useMemo(() => buildTree(items ?? []), [items]);
}

/** 标题上面的「父笔记 / 子笔记 /」 */
export function Breadcrumb({ it, open }: { it: Item; open: OpenFn }) {
  const tree = useTree();
  const path = tree.ancestors(it);
  if (!path.length) return null;
  return (
    <nav aria-label="所在位置" className="mb-1 flex flex-wrap items-center gap-0.5 text-[12.5px] text-faint">
      {path.map((p) => (
        <span key={p.id} className="flex items-center gap-0.5">
          <button className="max-w-[220px] truncate rounded px-1 py-0.5 hover:bg-surface-2 hover:text-fg" onClick={() => open(p.id)}>
            {noteTitle(p)}
          </button>
          <ChevronRight className="size-3" />
        </span>
      ))}
    </nav>
  );
}

/** 正文下面列出子笔记，可以新建 */
export function ChildNotes({ it, open }: { it: Item; open: OpenFn }) {
  const tree = useTree();
  const kids = tree.children(it.id);
  const create = async () => {
    const n = await addChild(it).catch(() => null);
    if (n) open(n.id, true);
  };
  if (!kids.length)
    return (
      <div className="mt-10" data-qa-skip>
        <Button tone="ghost" className="h-7 px-2 text-xs text-faint" onClick={create}>
          <Plus className="size-3.5" />
          新建子笔记
        </Button>
      </div>
    );
  return (
    <section className="mt-12 flex flex-col gap-1" aria-label="子笔记" data-qa-skip>
      <h3 className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-muted">
        <FileText className="size-4" /> 子笔记 <span className="font-normal text-faint">{kids.length}</span>
        <span className="grow" />
        <Button tone="ghost" className="h-7 px-2 text-xs" onClick={create}>
          <Plus className="size-3.5" />
          新建子笔记
        </Button>
      </h3>
      {kids.map((k) => {
        const n = tree.children(k.id).length;
        const snip = plain((k.body || "").replace(/!\[[^\]]*\]\([^)]*\)/g, "")).slice(0, 80);
        return (
          <button key={k.id} onClick={() => open(k.id)} className="flex items-baseline gap-3 rounded-lg px-2.5 py-2 text-left hover:bg-surface-2">
            <span className="shrink-0 text-[14px] font-medium text-fg">{noteTitle(k)}</span>
            <span className="min-w-0 grow truncate text-[13px] text-faint">{snip !== noteTitle(k) ? snip : ""}</span>
            {n > 0 && <span className="shrink-0 text-xs text-muted">{n} 篇子笔记</span>}
            <span className="shrink-0 text-xs text-faint">{ago(k.updatedAt)}</span>
          </button>
        );
      })}
    </section>
  );
}

/* ---------------------------------------------------------------- 移动到… */

export function openMove(it: Item) {
  openDialog((close) => <MoveDialog it={it} close={close} />);
}

function MoveDialog({ it, close }: { it: Item; close: () => void }) {
  const items = useAppState().data?.items ?? [];
  const tree = useMemo(() => buildTree(items), [items]);
  const [q, setQ] = useState("");
  const banned = useMemo(() => new Set([it.id, ...tree.descendants(it.id)]), [tree, it.id]);
  const pool = items.filter((x) => x.type === it.type && !banned.has(x.id));
  const rows: { it: Item; depth: number }[] = [];
  if (q.trim()) {
    const w = q.toLowerCase().split(/\s+/).filter(Boolean);
    pool.filter((x) => w.every((k) => noteTitle(x).toLowerCase().includes(k))).forEach((x) => rows.push({ it: x, depth: 0 }));
  } else {
    const seen = new Set<string>();
    const walk = (x: Item, d: number) => {
      if (seen.has(x.id) || banned.has(x.id)) return;
      seen.add(x.id);
      rows.push({ it: x, depth: d });
      tree.children(x.id).forEach((c) => walk(c, d + 1));
    };
    pool.filter((x) => tree.isRoot(x)).sort((a, b) => noteTitle(a).localeCompare(noteTitle(b), "zh")).forEach((x) => walk(x, 0));
  }
  const go = async (pid: string | null) => {
    close();
    if ((it.parentId || null) === pid) return;
    await moveUnder(it, pid).catch(() => {});
    say(pid ? `已移到「${noteTitle(tree.byId.get(pid)!)}」下面` : "已移到顶层");
  };
  const row = "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13.5px] hover:bg-surface-2";
  return (
    <Dialog title="移动到…" desc={`把「${noteTitle(it)}」放到哪篇下面？它的子笔记会一起移过去。`} onClose={close}>
      <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索标题" className={inputCls} aria-label="搜索标题" />
      <div className="-mx-2 flex max-h-[50vh] flex-col overflow-y-auto">
        {!q.trim() && (
          <button className={cx(row, !it.parentId && "text-accent")} onClick={() => go(null)}>
            顶层（不放在任何一篇下面）
          </button>
        )}
        {rows.map(({ it: x, depth }) => (
          <button key={x.id} className={cx(row, x.id === it.parentId && "text-accent")} style={{ paddingLeft: 8 + depth * 18 }} onClick={() => go(x.id)}>
            <FileText className="size-3.5 shrink-0 text-faint" />
            <span className="truncate">{noteTitle(x)}</span>
            {x.id === it.parentId && <span className="shrink-0 text-xs">（现在在这里）</span>}
          </button>
        ))}
        {!rows.length && <div className="px-2 py-4 text-center text-xs text-faint">没有可以放的笔记</div>}
      </div>
    </Dialog>
  );
}

/* ---------------------------------------------------------------- 列表：拖动改层级 */

const DND = "application/x-xp-note";
let dragging: string | null = null;

/** 列表里的笔记可以拖到另一篇上，变成它的子笔记 */
export function useNoteDnd(it: Item) {
  const [over, setOver] = useState(false);
  const ok = () => {
    if (!dragging || dragging === it.id) return false;
    const items = allItems();
    const tree = buildTree(items);
    return !tree.descendants(dragging).has(it.id);
  };
  return {
    over,
    props: {
      draggable: true,
      onDragStart: (e: DragEvent) => {
        e.stopPropagation();
        dragging = it.id;
        e.dataTransfer.setData(DND, it.id);
        e.dataTransfer.effectAllowed = "move";
      },
      onDragEnd: () => {
        dragging = null;
        setOver(false);
      },
      onDragOver: (e: DragEvent) => {
        if (!e.dataTransfer.types.includes(DND) || !ok()) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        setOver(true);
      },
      onDragLeave: () => setOver(false),
      onDrop: async (e: DragEvent) => {
        const id = e.dataTransfer.getData(DND);
        setOver(false);
        if (!id || !ok()) return;
        e.preventDefault();
        e.stopPropagation();
        dragging = null;
        const items = allItems();
        const src = items.find((x) => x.id === id);
        if (!src || src.parentId === it.id) return;
        await moveUnder(src, it.id).catch(() => {});
        say(`已放到「${noteTitle(it)}」下面`);
      },
    },
  };
}

/** 拖到列表空白处 = 移到顶层 */
export function rootDropProps() {
  return {
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes(DND)) return;
      e.preventDefault();
    },
    onDrop: async (e: DragEvent) => {
      const id = e.dataTransfer.getData(DND);
      if (!id) return;
      e.preventDefault();
      dragging = null;
      const src = (allItems()).find((x) => x.id === id);
      if (!src?.parentId) return;
      await moveUnder(src, null).catch(() => {});
      say("已移到顶层");
    },
  };
}

/* ---------------------------------------------------------------- 列表：子笔记行 */

export function SubRows({ parent, depth, sel, seen }: { parent: string; depth: number; sel?: string | null; seen: Set<string> }) {
  const tree = useTree();
  return (
    <>
      {tree.children(parent).map((k) => (seen.has(k.id) ? null : <SubRow key={k.id} it={k} depth={depth} sel={sel} seen={new Set([...seen, k.id])} />))}
    </>
  );
}

function SubRow({ it, depth, sel, seen }: { it: Item; depth: number; sel?: string | null; seen: Set<string> }) {
  const tree = useTree();
  const select = useUi((s) => s.select);
  const open = useOpenNodes((s) => !!s.open[it.id]);
  const toggle = useOpenNodes((s) => s.toggle);
  const n = tree.children(it.id).length;
  const dnd = useNoteDnd(it);
  const on = sel === it.id;
  return (
    <>
      <div
        {...dnd.props}
        onClick={() => select(it.id)}
        aria-current={on || undefined}
        className={cx(
          "group/row flex h-8 cursor-pointer items-center gap-1 rounded-lg pr-2 text-[13px]",
          on ? "bg-accent-soft font-medium text-accent-strong" : "text-fg-2 hover:bg-surface-2",
          dnd.over && "shadow-sel",
        )}
        style={{ paddingLeft: 6 + depth * 16 }}
      >
        {n > 0 ? (
          <button
            aria-label={open ? "收起" : "展开"}
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
        <span className="min-w-0 grow truncate">{noteTitle(it)}</span>
        {n > 0 && !open && <span className="text-[11px] text-faint">{n}</span>}
      </div>
      {open && n > 0 && <SubRows parent={it.id} depth={depth + 1} sel={sel} seen={seen} />}
    </>
  );
}
