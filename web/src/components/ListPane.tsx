/* 中间的列表：事项（焦点 + 三栏）、笔记、入口（按所在机器分组）、规范 */
import { Check, Copy, Disc, ExternalLink, Folder, Globe, Monitor, Pin, Plus, Search, Server, Star } from "lucide-react";
import { useMemo } from "react";
import { copyText, openTarget } from "../lib/api";
import { addItem, patchItem, useAppState, useDevices } from "../lib/data";
import { ago, byPriority, byRecent, deviceByHost, devOnline, dueInfo, entryTarget, hostOf, imageRefs, inCat, noteTitle, plain, type HostKind } from "../lib/logic";
import { useUi } from "../lib/store";
import type { Item } from "../lib/types";
import { TYPES } from "../lib/types";
import { useMyWorkspace } from "../lib/ws";
import { cx } from "../lib/cx";
import { Thumb } from "./Markdown";
import { Button, Chip, Pri } from "./ui";

export function useFilter() {
  const { cat, tag, q, dev } = useUi();
  return (it: Item) => {
    if (cat === "none" ? !!it.category : cat && !inCat(it.category, cat)) return false;
    if (tag && !(it.tags || []).includes(tag)) return false;
    if (dev && it.device && it.device !== dev) return false;
    if (q) {
      const hay = `${it.title}\n${it.body || ""}\n${(it.tags || []).join(" ")}\n${it.category || ""}`.toLowerCase();
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
        id="xp-search"
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
  const ui = useUi();
  const di = dueInfo(it);
  const p = (it.agentProgress || []).slice(-1)[0];
  const ws = useMyWorkspace(it);
  return (
    <span className="flex flex-wrap items-center gap-1.5 text-xs">
      {di && <Chip tone={di.tone === "late" ? "danger" : di.tone === "soon" ? "warn" : "plain"}>{di.text}</Chip>}
      {it.category && ui.cat !== it.category && <span className="text-muted">{it.category}</span>}
      {(it.qa || []).length > 0 && <Chip>{(it.qa || []).length} 条问答</Chip>}
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

function NoteCard({ it, on }: { it: Item; on: boolean }) {
  const select = useUi((s) => s.select);
  const imgs = imageRefs(it.body);
  const snippet = plain((it.body || "").replace(/!\[[^\]]*\]\([^)]*\)/g, "")).slice(0, 90);
  return (
    <button
      onClick={() => select(it.id)}
      aria-current={on || undefined}
      className={cx(
        "flex w-full flex-col gap-1.5 rounded-[14px] border-2 bg-surface px-4 py-3.5 text-left transition-shadow",
        on ? "border-accent shadow-[0_6px_18px_rgb(47_91_234/0.10)]" : "border-transparent shadow-1 hover:shadow-2",
      )}
    >
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
  );
}

function TaskRow({ it, on }: { it: Item; on: boolean }) {
  const select = useUi((s) => s.select);
  const check = TYPES.find((t) => t.k === it.type)?.check;
  return (
    <div
      className={cx(
        "group flex items-start gap-2.5 rounded-xl border-2 bg-surface px-3 py-2.5 transition-shadow",
        on ? "border-accent" : "border-transparent shadow-1 hover:shadow-2",
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
        {(it.body || "").trim() && !it.done && <span className="line-clamp-1 text-xs text-muted">{plain(it.body)}</span>}
        <ItemMeta it={it} />
      </button>
      <button
        aria-label={it.pinned ? "移出焦点" : "设为焦点"}
        title={it.pinned ? "移出焦点" : "设为焦点"}
        onClick={() => patchItem(it, { pinned: !it.pinned })}
        className={cx("grid size-7 shrink-0 place-items-center rounded-md hover:bg-surface-3 [&_svg]:size-3.5", it.pinned ? "text-accent" : "text-faint opacity-0 group-hover:opacity-100")}
      >
        <Pin />
      </button>
    </div>
  );
}

const HOST_ICON: Record<HostKind, typeof Monitor> = { pc: Monitor, server: Server, web: Globe, disk: Disc, other: Folder };

function LinkRow({ it, on }: { it: Item; on: boolean }) {
  const ui = useUi();
  const t = entryTarget(it);
  return (
    <div className={cx("group flex items-center gap-2 rounded-xl border-2 bg-surface px-3.5 py-2.5", on ? "border-accent" : "border-transparent shadow-1 hover:shadow-2")}>
      <button onClick={() => ui.select(it.id)} className="flex min-w-0 grow flex-col text-left">
        <span className="truncate text-[14px] font-semibold">
          {it.pinned && <Pin className="mr-1 inline size-3.5 text-accent" />}
          {it.title}
        </span>
        <span className="truncate font-mono text-xs text-muted" title={t || ""}>
          {t || "还没填网址或路径"}
        </span>
      </button>
      {t && (
        <>
          <button
            aria-label="复制"
            title="复制"
            onClick={async () => (await copyText(t)) && ui.say("已复制：" + t)}
            className="grid size-8 place-items-center rounded-lg text-muted opacity-0 group-hover:opacity-100 hover:bg-surface-3 hover:text-fg [&_svg]:size-4"
          >
            <Copy />
          </button>
          <button
            aria-label="打开"
            title="打开"
            onClick={() => openTarget(t).then((r) => r === "copied" && ui.say("网页版不能直接打开本地路径，已复制：" + t))}
            className="grid size-8 place-items-center rounded-lg text-muted hover:bg-accent-soft hover:text-accent [&_svg]:size-4"
          >
            <ExternalLink />
          </button>
        </>
      )}
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
  const filtering = !!(ui.q || ui.tag || ui.dev || ui.cat);

  const title =
    ui.cat === "none" ? "未分类" : ui.cat ? ui.cat.split("/").pop() : ui.tag ? "#" + ui.tag : { inbox: "收件箱", work: "事项", notes: "笔记", links: "入口", rules: "规范与工作流" }[ui.view];

  const body = useMemo(() => {
    const empty = (text: string) => <div className="px-1 py-6 text-center text-[13px] text-faint">{filtering ? "没有匹配的内容" : text}</div>;
    if (ui.view === "notes" || ui.view === "rules") {
      const type = ui.view === "notes" ? "note" : "rule";
      const list = items.filter((i) => i.type === type && match(i)).sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || byRecent(a, b));
      return {
        count: list.length,
        node: list.length ? list.map((it) => <NoteCard key={it.id} it={it} on={sel === it.id} />) : empty(type === "note" ? "还没有笔记" : "写下固定的做法和约定"),
      };
    }
    if (ui.view === "links") {
      const list = items.filter((i) => i.type === "link" && match(i));
      const groups = new Map<string, { key: string; kind: HostKind; items: Item[] }>();
      for (const it of list) {
        const h = hostOf(entryTarget(it));
        if (!groups.has(h.key)) groups.set(h.key, { ...h, items: [] });
        groups.get(h.key)!.items.push(it);
      }
      const order = (k: HostKind) => ({ pc: 0, server: 1, disk: 2, web: 3, other: 4 })[k];
      const arr = [...groups.values()].sort((a, b) => order(a.kind) - order(b.kind) || a.key.localeCompare(b.key));
      return {
        count: list.length,
        node: arr.length
          ? arr.map((g) => {
              const Icon = HOST_ICON[g.kind];
              const dv = g.kind === "pc" || g.kind === "server" ? deviceByHost(devices, g.key) : undefined;
              g.items.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || a.title.localeCompare(b.title, "zh"));
              return (
                <section key={g.key} className="flex flex-col gap-2">
                  <h2 className="flex items-center gap-1.5 px-1 text-xs font-semibold text-muted [&_svg]:size-3.5">
                    <Icon className="text-link" />
                    {dv ? (
                      <>
                        <span className={cx("size-1.5 rounded-full", devOnline(dv) ? "bg-ok" : "bg-faint")} />
                        {dv.name}
                        {dv.name.toUpperCase() !== g.key && <span className="font-normal text-faint">{g.key}</span>}
                      </>
                    ) : (
                      g.key
                    )}
                    <span className="grow" />
                    <span className="font-normal">{g.items.length}</span>
                  </h2>
                  {g.items.map((it) => (
                    <LinkRow key={it.id} it={it} on={sel === it.id} />
                  ))}
                </section>
              );
            })
          : empty("在下面的快速记录里选「入口」，粘贴一个共享文件夹路径或网址就能加进来"),
      };
    }
    // 事项
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
                <Star className="text-accent" /> 当前焦点 <span className="font-normal">{focus.length}</span>
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
              <section key={l.k} id={"lane-" + l.k} className="flex flex-col gap-2">
                <h2 className="flex items-center gap-1 px-1 text-xs font-semibold text-muted">
                  <span style={{ color: `var(--${l.k})` }}>{l.name}</span>
                  <span className="font-normal">{open.length || ""}</span>
                  <span className="grow" />
                  <button
                    aria-label={"新建" + l.name}
                    title={"新建" + l.name}
                    onClick={() => ui.focusCapture(l.k)}
                    className="grid size-6 place-items-center rounded-md text-faint hover:bg-surface hover:text-accent [&_svg]:size-3.5"
                  >
                    <Plus />
                  </button>
                </h2>
                {open.map((it) => (
                  <TaskRow key={it.id} it={it} on={sel === it.id} />
                ))}
                {open.length === 0 && <div className="px-1 text-xs text-faint">{filtering ? "没有匹配的内容" : "清空了"}</div>}
                {done.length > 0 && (
                  <details className="px-1 text-xs text-muted">
                    <summary className="cursor-pointer py-1 select-none">
                      已{l.check} {done.length}
                    </summary>
                    <div className="mt-2 flex flex-col gap-2">
                      {done.slice(0, 50).map((it) => (
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, devices, ui.view, ui.cat, ui.tag, ui.q, ui.dev, sel]);

  async function create() {
    if (ui.view === "notes") {
      const it = await addItem({ type: "note", title: "", body: "", ...(ui.cat && ui.cat !== "none" ? { category: ui.cat } : {}), tags: ui.tag ? [ui.tag] : [] }).catch(() => null);
      if (it) {
        ui.select(it.id);
        if (ui.mode === "read") ui.setMode("edit");
      }
      return;
    }
    ui.focusCapture();
  }

  return (
    <section aria-label="列表" className="flex w-[340px] shrink-0 flex-col gap-3.5 max-[1200px]:w-[290px]">
      <SearchBox />
      <div className="flex items-center gap-2 px-1">
        <h1 className="truncate text-[19px] font-bold">{title}</h1>
        <span className="text-[13px] whitespace-nowrap text-muted">
          {body.count} {ui.view === "notes" || ui.view === "rules" ? "篇" : "条"}
        </span>
        {filtering && (
          <button className="text-xs whitespace-nowrap text-accent hover:underline" onClick={() => useUi.setState({ cat: null, tag: null, q: "", dev: null })}>
            清除筛选
          </button>
        )}
        <span className="grow" />
        <Button tone="primary" onClick={create} title={ui.view === "notes" ? "新建笔记" : "在快速记录里写"}>
          <Plus className="size-4" />
          新建
        </Button>
      </div>
      <div className="scroll-quiet -mr-2 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-2 pb-6">{body.node}</div>
    </section>
  );
}
