import { Check, ExternalLink, Plus, Search, Star } from "lucide-react";
import { useMemo } from "react";
import { openTarget } from "../lib/api";
import { addItem, patchItem, useAppState } from "../lib/data";
import { ago, byPriority, byRecent, dueInfo, entryTarget, imageRefs, inCat, noteTitle, plain } from "../lib/logic";
import { useUi } from "../lib/store";
import type { Item } from "../lib/types";
import { TYPES } from "../lib/types";
import { cx } from "../lib/cx";
import { Thumb } from "./Markdown";
import { Button, Chip, Pri } from "./ui";

export function useFilter() {
  const { cat, tag, q } = useUi();
  return (it: Item) => {
    if (cat === "none" ? !!it.category : cat && !inCat(it.category, cat)) return false;
    if (tag && !(it.tags || []).includes(tag)) return false;
    if (q) {
      const hay = `${it.title}\n${it.body || ""}\n${(it.tags || []).join(" ")}`.toLowerCase();
      if (!q.toLowerCase().split(/\s+/).every((w) => hay.includes(w))) return false;
    }
    return true;
  };
}

function SearchBox() {
  const { q, setQ } = useUi();
  return (
    <label className="flex h-[42px] shrink-0 items-center gap-2 rounded-xl bg-surface px-3.5 text-muted shadow-1">
      <Search className="size-4" />
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="搜索全部内容"
        aria-label="搜索"
        className="min-w-0 grow bg-transparent text-fg outline-none placeholder:text-faint"
      />
    </label>
  );
}

function ItemMeta({ it }: { it: Item }) {
  const di = dueInfo(it);
  const p = (it.agentProgress || []).slice(-1)[0];
  const ws = (it.workspaces || [])[0];
  return (
    <span className="flex flex-wrap items-center gap-1.5 text-xs">
      {di && <Chip tone={di.tone === "late" ? "danger" : di.tone === "soon" ? "warn" : "plain"}>{di.text}</Chip>}
      {(it.qa || []).length > 0 && <Chip>{(it.qa || []).length} 条问答</Chip>}
      {p && <Chip tone={p.status === "blocked" ? "danger" : p.status === "done" ? "accent" : "warn"}>AI {p.status === "blocked" ? "卡住了" : p.status === "done" ? "完成" : "进行中"}</Chip>}
      {ws && <Chip>{ws.name}</Chip>}
      {(it.tags || []).slice(0, 3).map((t) => (
        <span key={t} className="text-faint">#{t}</span>
      ))}
      <span className="text-faint">{ago(it.updatedAt)}</span>
    </span>
  );
}

function NoteCard({ it, on }: { it: Item; on: boolean }) {
  const select = useUi((s) => s.select);
  const imgs = imageRefs(it.body);
  const snippet = plain(it.body).slice(0, 90);
  return (
    <button
      onClick={() => select(it.id)}
      className={cx(
        "flex w-full flex-col gap-1.5 rounded-[14px] border-2 bg-surface px-4 py-3.5 text-left transition-shadow",
        on ? "border-accent shadow-[0_6px_18px_rgb(47_91_234/0.10)]" : "border-transparent shadow-1 hover:shadow-2",
      )}
    >
      <span className="line-clamp-2 text-[15px] font-semibold text-fg">{noteTitle(it)}</span>
      {snippet && snippet !== noteTitle(it) && <span className="line-clamp-2 text-[13px] leading-relaxed text-muted">{snippet}</span>}
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
  );
}

function TaskRow({ it, on }: { it: Item; on: boolean }) {
  const select = useUi((s) => s.select);
  return (
    <div
      className={cx(
        "flex items-start gap-2.5 rounded-xl border-2 bg-surface px-3 py-2.5 transition-shadow",
        on ? "border-accent" : "border-transparent shadow-1 hover:shadow-2",
      )}
    >
      <button
        role="checkbox"
        aria-checked={!!it.done}
        aria-label={it.title}
        title={it.done ? "取消完成" : "完成"}
        onClick={() => patchItem(it, { done: !it.done })}
        className={cx(
          "mt-0.5 grid size-[18px] shrink-0 place-items-center rounded-[5px] border-[1.5px] transition-colors [&_svg]:size-3",
          it.done ? "border-accent bg-accent text-on-accent" : "border-faint text-transparent hover:border-accent",
        )}
      >
        <Check strokeWidth={3} />
      </button>
      <button onClick={() => select(it.id)} className="flex min-w-0 grow flex-col gap-1 text-left">
        <span className={cx("text-sm", it.done ? "text-faint line-through" : "text-fg")}>
          <Pri p={it.done ? undefined : it.priority} />
          {it.title}
        </span>
        <ItemMeta it={it} />
      </button>
    </div>
  );
}

export function ListPane() {
  const { data } = useAppState();
  const items = data?.items ?? [];
  const ui = useUi();
  const match = useFilter();
  const sel = ui.selected[ui.view];

  const title = ui.cat === "none" ? "未分类" : ui.cat ? ui.cat.split("/").pop() : ui.tag ? "#" + ui.tag : { inbox: "收件箱", work: "事项", notes: "笔记", links: "入口" }[ui.view];

  const body = useMemo(() => {
    if (ui.view === "notes") {
      const list = items.filter((i) => i.type === "note" && match(i)).sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || byRecent(a, b));
      return { count: list.length, node: list.map((it) => <NoteCard key={it.id} it={it} on={sel === it.id} />) };
    }
    if (ui.view === "links") {
      const list = items.filter((i) => i.type === "link" && match(i)).sort(byRecent);
      return {
        count: list.length,
        node: list.map((it) => {
          const t = entryTarget(it);
          return (
            <div key={it.id} className={cx("flex items-center gap-2 rounded-[14px] border-2 bg-surface px-4 py-3", sel === it.id ? "border-accent" : "border-transparent shadow-1")}>
              <button onClick={() => ui.select(it.id)} className="flex min-w-0 grow flex-col text-left">
                <span className="truncate text-[15px] font-semibold">{it.title}</span>
                <span className="truncate font-mono text-xs text-muted">{t || "（没有识别到网址或路径）"}</span>
              </button>
              {t && (
                <button
                  aria-label="打开"
                  title="打开"
                  onClick={() => openTarget(t).then((r) => r === "copied" && ui.say("已复制：" + t))}
                  className="grid size-8 place-items-center rounded-lg text-muted hover:bg-surface-3 hover:text-accent [&_svg]:size-4"
                >
                  <ExternalLink />
                </button>
              )}
            </div>
          );
        }),
      };
    }
    if (ui.view === "work") {
      const lanes = TYPES.filter((t) => t.lane);
      const all = items.filter((i) => lanes.some((l) => l.k === i.type) && match(i));
      const focus = all.filter((i) => i.pinned && !i.done).sort(byPriority);
      return {
        count: all.filter((i) => !i.done).length,
        node: (
          <>
            {focus.length > 0 && (
              <section className="flex flex-col gap-2">
                <h2 className="flex items-center gap-1.5 px-1 text-xs font-semibold text-muted [&_svg]:size-3.5">
                  <Star className="text-accent" /> 当前焦点
                </h2>
                {focus.map((it) => (
                  <TaskRow key={it.id} it={it} on={sel === it.id} />
                ))}
              </section>
            )}
            {lanes.map((l) => {
              const open = all.filter((i) => i.type === l.k && !i.done && !i.pinned).sort(byPriority);
              const done = all.filter((i) => i.type === l.k && i.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
              return (
                <section key={l.k} className="flex flex-col gap-2">
                  <h2 className="flex items-center justify-between px-1 text-xs font-semibold text-muted">
                    <span style={{ color: `var(--${l.k})` }}>{l.name}</span>
                    <span className="font-normal">{open.length || ""}</span>
                  </h2>
                  {open.map((it) => (
                    <TaskRow key={it.id} it={it} on={sel === it.id} />
                  ))}
                  {open.length === 0 && <div className="px-1 text-xs text-faint">清空了</div>}
                  {done.length > 0 && (
                    <details className="px-1 text-xs text-muted">
                      <summary className="cursor-pointer select-none py-1">已{l.check} {done.length}</summary>
                      <div className="mt-2 flex flex-col gap-2">
                        {done.slice(0, 30).map((it) => (
                          <TaskRow key={it.id} it={it} on={sel === it.id} />
                        ))}
                      </div>
                    </details>
                  )}
                </section>
              );
            })}
          </>
        ),
      };
    }
    return { count: 0, node: null };
  }, [items, ui.view, sel, match, ui]);

  const create = async () => {
    const type = ui.view === "links" ? "link" : ui.view === "work" ? "todo" : "note";
    const cat = ui.cat && ui.cat !== "none" ? ui.cat : undefined;
    const it = await addItem({ type, title: type === "note" ? "" : "新的待办", category: cat, tags: ui.tag ? [ui.tag] : [] });
    ui.select(it.id);
    ui.setMode("edit");
  };

  return (
    <section aria-label="列表" className="flex w-[330px] shrink-0 flex-col gap-2.5 py-0.5">
      <SearchBox />
      <div className="flex items-center justify-between px-1 pt-1.5">
        <h1 className="m-0 truncate text-lg font-bold">
          {title} <span className="text-[13px] font-normal text-muted">{body.count} {ui.view === "notes" ? "篇" : "条"}</span>
        </h1>
        <Button tone="primary" onClick={create} className="h-8 rounded-[9px] px-3 [&_svg]:size-4">
          <Plus /> 新建
        </Button>
      </div>
      <div className="scroll-quiet -mx-1 flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-1 pb-4">{body.node}</div>
    </section>
  );
}
