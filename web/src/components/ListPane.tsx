/* 事项、笔记、规范的整页：事项是焦点 + 几栏卡片，笔记和规范是多列卡片。点一条在右侧面板里打开，不再分左右栏 */
import { Check, ChevronRight, Copy, Link2, Folder, Pin, Plus, Star } from "lucide-react";
import { useEffect, useMemo } from "react";
import { copyText } from "../lib/api";

/** 列表里悬停出现的「复制」：复制标题和正文（Markdown） */
function CopyBtn({ text, className }: { text: string; className?: string }) {
  return (
    <button
      aria-label="复制"
      title="复制标题和正文"
      onClick={async (e) => {
        e.stopPropagation();
        useUi.getState().say((await copyText(text)) ? "已复制" : "复制失败");
      }}
      className={cx("grid size-7 shrink-0 place-items-center rounded-md text-faint opacity-0 group-hover:opacity-100 hover:bg-surface-3 hover:text-fg [&_svg]:size-3.5", className)}
    >
      <Copy />
    </button>
  );
}
const fullText = (it: Item) => [it.title, it.body].filter(Boolean).join("\n\n");
import { addItem, patchItem, useAppState, useDevices } from "../lib/data";
import { ago, byPriority, byRecent, dueInfo, imageRefs, inCat, noteTitle, plain, viewOf, VIEW_NAME } from "../lib/logic";
import { useUi, type View } from "../lib/store";
import type { Item } from "../lib/types";
import { TYPES } from "../lib/types";
import { useMyWorkspace } from "../lib/ws";
import { cx } from "../lib/cx";
import { Thumb } from "./Markdown";
import { rootDropProps, SubRows, useNoteDnd } from "./Tree";
import { buildTree, useOpenNodes } from "../lib/tree";
import { linksOf } from "../lib/links";
import { NO_PROJECT, projectOf } from "../lib/projects";
import { itemMatches, tokensOf } from "../lib/search";
import { CatBar, Filters, SearchBox } from "./Filters";
import { useProjects } from "./Projects";
import { Button, Chip, Pri } from "./ui";

export function useFilter() {
  const { cat, tag, q, dev, proj } = useUi();
  const projects = useProjects();
  const toks = tokensOf(q);
  return (it: Item) => {
    if (proj && (proj === NO_PROJECT ? !!projectOf(it, projects) : projectOf(it, projects)?.id !== proj)) return false;
    if (cat === "none" ? !!it.category : cat && !inCat(it.category, cat)) return false;
    if (tag && !(it.tags || []).includes(tag)) return false;
    if (dev && it.device && it.device !== dev) return false;
    if (toks.length && !itemMatches(it, toks)) return false;
    return true;
  };
}

/** 按分类、标签筛选时这个页面里一条都没有，但别的页面里有：说出来在哪，点一下过去。
    免得看到分类里明明有东西、这里却是空的，以为内容丢了 */
export function Elsewhere() {
  const items = useAppState().data?.items ?? [];
  const ui = useUi();
  const match = useFilter();
  const filtering = !!(ui.q || ui.tag || ui.dev || ui.cat || ui.proj);
  const elsewhere = useMemo(() => {
    if (!filtering || ui.view === "vault") return [];
    const by = new Map<View, number>();
    for (const i of items) {
      const v = viewOf(i);
      if (v && i.type !== "project" && match(i)) by.set(v, (by.get(v) ?? 0) + 1);
    }
    return by.get(ui.view as Exclude<View, "vault">) ? [] : [...by];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, ui.view, ui.cat, ui.tag, ui.q, ui.dev, ui.proj]);
  if (!elsewhere.length) return null;
  return (
    <div className="flex shrink-0 flex-col gap-2 rounded-xl bg-surface-2 px-3.5 py-3 text-[13px] text-fg-2">
      <span>「{VIEW_NAME[ui.view]}」里没有符合的，内容在别的页面：</span>
      <span className="flex flex-wrap gap-1.5">
        {elsewhere.map(([v, n]) => (
          <button key={v} onClick={() => ui.setView(v)} className="rounded-lg bg-surface px-2.5 py-1 font-medium text-fg hover:bg-surface-3">
            {VIEW_NAME[v]} {n} 条 →
          </button>
        ))}
      </span>
    </div>
  );
}

function ItemMeta({ it }: { it: Item }) {
  const ui = useUi();
  const di = dueInfo(it);
  const p = (it.agentProgress || []).slice(-1)[0];
  const ws = useMyWorkspace(it);
  return (
    <span className="flex flex-wrap items-center gap-1.5 text-xs">
      {di && <Chip tone={di.tone === "late" ? "danger" : di.tone === "soon" ? "warn" : "plain"}>{di.text}</Chip>}
      {it.category && ui.cat !== it.category && <span className="text-muted">{it.category}</span>}
      {(it.qa || []).length > 0 && <Chip>{(it.qa || []).length} 条评论</Chip>}
      {linksOf(it).length > 0 && (
        <span className="inline-flex items-center gap-0.5 text-muted [&_svg]:size-3" title="关联的条目">
          <Link2 /> {linksOf(it).length}
        </span>
      )}
      {p && <Chip tone={p.status === "blocked" ? "danger" : p.status === "done" ? "accent" : "warn"}>AI {p.status === "blocked" ? "卡住了" : p.status === "done" ? "完成" : "进行中"}</Chip>}
      {ws && (
        <Chip>
          <Folder /> {ws.name}
        </Chip>
      )}
      {it.device && <span className="text-muted">@{it.device}</span>}
      {(it.tags || []).slice(0, 3).map((t) => (
        <span key={t} className="text-faint">
          #{t}
        </span>
      ))}
      <span className="text-faint" title={new Date(it.updatedAt || 0).toLocaleString()}>
        {ago(it.updatedAt)}
      </span>
    </span>
  );
}

function NoteCard({ it, on, kids = 0, crumb, sel }: { it: Item; on: boolean; kids?: number; crumb?: string; sel?: string | null }) {
  const peek = useUi((s) => s.openPeek);
  const open = useOpenNodes((s) => !!s.open[it.id]);
  const toggle = useOpenNodes((s) => s.toggle);
  const dnd = useNoteDnd(it);
  const imgs = imageRefs(it.body);
  const snippet = plain((it.body || "").replace(/!\[[^\]]*\]\([^)]*\)/g, "")).slice(0, 90);
  return (
    <div {...dnd.props} data-item-id={it.id} className={cx("group relative rounded-[18px] transition-colors", dnd.over ? "bg-accent-soft" : on ? "bg-surface-3" : "bg-surface hover:bg-surface-2")}>
      <CopyBtn text={fullText(it)} className="absolute top-2.5 right-2.5 z-10" />
      <button onClick={() => peek(it.id)} aria-current={on || undefined} className="flex w-full flex-col gap-1.5 rounded-[18px] px-4 py-3.5 text-left">
        {crumb && <span className="-mb-1 truncate text-[11.5px] text-faint">{crumb} /</span>}
        <span className="line-clamp-2 text-[15px] font-semibold text-fg">
          {it.pinned && <Pin className="mr-1 inline size-3.5 text-accent" />}
          {noteTitle(it)}
        </span>
        {snippet && snippet !== noteTitle(it) && !snippet.startsWith(noteTitle(it) + " ") && <span className="line-clamp-2 text-[13px] leading-relaxed text-muted">{snippet}</span>}
        {imgs.length > 0 && (
          <span className="flex gap-1.5">
            {imgs.slice(0, 4).map((n) => (
              <Thumb key={n} name={n} className="h-11 w-16 rounded-md object-cover" />
            ))}
            {imgs.length > 4 && <span className="self-center text-xs text-muted">+{imgs.length - 4}</span>}
          </span>
        )}
        <ItemMeta it={it} />
      </button>
      {kids > 0 && (
        <div className="-mt-1.5 px-1.5 pb-2">
          <button onClick={() => toggle(it.id)} className="flex h-7 items-center gap-1 rounded-lg px-2 text-xs text-muted hover:bg-surface-3 hover:text-fg">
            <ChevronRight className={cx("size-3.5 transition-transform", open && "rotate-90")} />
            {kids} 篇子笔记
          </button>
          {open && <SubRows parent={it.id} depth={0} sel={sel} seen={new Set([it.id])} />}
        </div>
      )}
    </div>
  );
}

function TaskRow({ it, on }: { it: Item; on: boolean }) {
  const select = useUi((s) => s.openPeek);
  const check = TYPES.find((t) => t.k === it.type)?.check;
  return (
    <div
      data-item-id={it.id}
      className={cx(
        "group relative flex items-start gap-2.5 rounded-xl px-3 py-2 transition-colors",
        on ? "bg-surface-3" : "hover:bg-surface-2",
      )}
    >
      <button
        role="checkbox"
        aria-checked={!!it.done}
        aria-label={it.title}
        title={it.done ? "取消完成" : check}
        onClick={() => patchItem(it, { done: !it.done })}
        className={cx(
          "mt-0.5 grid size-[18px] shrink-0 place-items-center rounded-[5px] border-[1.5px] transition-colors [&_svg]:size-3",
          it.done ? "border-ink bg-ink text-on-ink" : "border-faint text-transparent hover:border-fg",
        )}
      >
        <Check strokeWidth={3} />
      </button>
      {/* 标题后面紧跟着时间、标签这些，放得下就同一行，一条只占一行 */}
      <button onClick={() => select(it.id)} className="flex min-w-0 grow flex-wrap items-baseline gap-x-2.5 gap-y-0.5 pr-7 text-left">
        <span className={cx("text-sm", it.done ? "text-faint line-through" : "text-fg")}>
          {it.pinned && !it.done && <Pin className="mr-1 inline size-3.5 align-[-2px] text-accent" />}
          <Pri p={it.done ? undefined : it.priority} />
          {it.title}
        </span>
        <ItemMeta it={it} />
        {(it.body || "").trim() && !it.done && <span className="line-clamp-1 basis-full text-xs text-muted">{plain(it.body)}</span>}
      </button>
      {/* 悬停时浮在右上角，不单独占一列 */}
      <button
        aria-label={it.pinned ? "移出焦点" : "设为焦点"}
        title={it.pinned ? "移出焦点" : "设为焦点"}
        onClick={() => patchItem(it, { pinned: !it.pinned })}
        className={cx(
          "absolute top-2 right-2 grid size-7 place-items-center rounded-md opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-surface-3 [&_svg]:size-3.5",
          on ? "bg-surface-3" : "bg-surface-2",
          it.pinned ? "text-accent" : "text-faint hover:text-fg",
        )}
      >
        <Pin />
      </button>
    </div>
  );
}

export function ListPane() {
  const { data } = useAppState();
  const items = data?.items ?? [];
  const devices = useDevices();
  const ui = useUi();
  const match = useFilter();
  const sel = ui.selected[ui.view];
  const filtering = !!(ui.q || ui.tag || ui.dev || ui.cat || ui.proj);

  // 从别处跳到某一条（搜索、快速记录的「查看」、右侧面板的「到它所在的页面」）：这里没有阅读栏，在右侧面板里打开；
  // 是子笔记的话把上面几层展开，列表里也找得到
  useEffect(() => {
    if (!sel) return;
    ui.select(null);
    if (!items.some((i) => i.id === sel)) return;
    if (ui.view === "notes" || ui.view === "rules") {
      const t = buildTree(items);
      const it = t.byId.get(sel);
      if (it) t.ancestors(it).forEach((a) => !useOpenNodes.getState().open[a.id] && useOpenNodes.getState().toggle(a.id, true));
    }
    if (ui.peek?.id !== sel) ui.openPeek(sel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, ui.view]);
  const on = ui.peek?.id;

  const title = ui.view === "rules" ? "规范与工作流" : VIEW_NAME[ui.view];

  const body = useMemo(() => {
    const empty = (text: string) => <div className="px-1 py-6 text-center text-[13px] text-faint">{filtering ? "没有匹配的内容" : text}</div>;
    if (ui.view === "notes" || ui.view === "rules") {
      const type = ui.view === "notes" ? "note" : "rule";
      const list = items.filter((i) => i.type === type && match(i)).sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || byRecent(a, b));
      const tree = buildTree(items.filter((i) => i.type === type));
      // 筛选时平铺（标题上面写着在哪篇下面）；不筛选时只列顶层，子笔记收在卡片里
      const shown = filtering ? list : list.filter((x) => tree.isRoot(x));
      return {
        count: list.length,
        node: shown.length ? (
          // 按网格排：最近的在左上，往右再往下，和阅读顺序一致
          <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] items-start gap-3">
            {shown.map((it) => (
              <div key={it.id}>
                <NoteCard
                  it={it}
                  on={on === it.id}
                  sel={on}
                  kids={filtering ? 0 : tree.children(it.id).length}
                  crumb={filtering ? tree.ancestors(it).map(noteTitle).join(" / ") : undefined}
                />
              </div>
            ))}
          </div>
        )
          : empty(type === "note" ? "还没有笔记" : "写下固定的做法和约定"),
      };
    }
    // 事项
    const lanes = TYPES.filter((t) => t.lane);
    const all = items.filter((i) => lanes.some((l) => l.k === i.type) && match(i));
    const focus = all.filter((i) => i.pinned && !i.done).sort(byPriority);
    return {
      count: all.filter((i) => !i.done).length,
      node: (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(340px,1fr))] items-start gap-3">
          {focus.length > 0 && (
            <section className="col-span-full flex flex-col gap-1 rounded-[18px] bg-surface p-2.5">
              <h2 className="flex items-center gap-1.5 px-2 pt-1 pb-1 text-xs font-semibold text-muted [&_svg]:size-3.5">
                <Star className="text-accent" /> 当前焦点 <span className="font-normal">{focus.length}</span>
              </h2>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-1">
                {focus.map((it) => (
                  <TaskRow key={it.id} it={it} on={on === it.id} />
                ))}
              </div>
            </section>
          )}
          {lanes.map((l) => {
            const open = all.filter((i) => i.type === l.k && !i.done && !i.pinned).sort(byPriority);
            const done = all.filter((i) => i.type === l.k && i.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
            return (
              <section key={l.k} id={"lane-" + l.k} className="flex flex-col gap-1 rounded-[18px] bg-surface p-2.5">
                <h2 className="flex items-center gap-1 px-2 pt-1 text-xs font-semibold text-muted">
                  <span style={{ color: `var(--${l.k})` }}>{l.name}</span>
                  <span className="font-normal">{open.length || ""}</span>
                  <span className="grow" />
                  <button
                    aria-label={"新建" + l.name}
                    title={"新建" + l.name}
                    onClick={() => ui.focusCapture(l.k)}
                    className="grid size-6 place-items-center rounded-md text-faint hover:bg-surface-2 hover:text-accent [&_svg]:size-3.5"
                  >
                    <Plus />
                  </button>
                </h2>
                {open.map((it) => (
                  <TaskRow key={it.id} it={it} on={on === it.id} />
                ))}
                {open.length === 0 && <div className="px-3 py-2 text-xs text-faint">{filtering ? "没有匹配的内容" : "清空了"}</div>}
                {done.length > 0 && (
                  <details className="px-2 text-xs text-muted">
                    <summary className="cursor-pointer py-1.5 select-none">
                      {l.check?.startsWith("已") ? l.check : "已" + l.check} {done.length}
                    </summary>
                    <div className="-mx-2 flex flex-col gap-1 pb-1">
                      {done.slice(0, 50).map((it) => (
                        <TaskRow key={it.id} it={it} on={on === it.id} />
                      ))}
                    </div>
                  </details>
                )}
              </section>
            );
          })}
        </div>
      ),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, devices, ui.view, ui.cat, ui.tag, ui.q, ui.dev, ui.proj, on]);

  async function create() {
    if (ui.view === "notes" || ui.view === "rules") {
      const it = await addItem({ type: ui.view === "notes" ? "note" : "rule", title: "", body: "", ...(ui.cat && ui.cat !== "none" ? { category: ui.cat } : {}), tags: ui.tag ? [ui.tag] : [] }).catch(() => null);
      if (it) ui.openPeek(it.id, "edit");
      return;
    }
    ui.focusCapture();
  }

  return (
    <main key={ui.view} aria-label={title} className="scroll-quiet flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto pb-20">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-1">
        <h1 className="text-[19px] font-bold">{title}</h1>
        <span className="text-[13px] whitespace-nowrap text-muted">
          {body.count} {ui.view === "notes" || ui.view === "rules" ? "篇" : "条"}
        </span>
        <span className="grow" />
        <SearchBox />
        <Filters bar />
        <Button tone="primary" onClick={create} title={ui.view === "notes" ? "新建笔记" : ui.view === "rules" ? "新建规范" : "在快速记录里写"}>
          <Plus className="size-4" />
          新建
        </Button>
      </div>
      <CatBar />
      <Elsewhere />
      <div className="flex min-h-[40vh] shrink-0 flex-col" {...(ui.view === "notes" || ui.view === "rules" ? rootDropProps() : {})}>
        {body.node}
      </div>
    </main>
  );
}
