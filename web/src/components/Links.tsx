/* 入口页：不分左右栏，一个分组一张卡片，卡片顺着排成几列。
   - 分组就是条目的分类：可以自己建（学习视频、有趣的项目…），没分类的按所在的机器自动分。
   - 每条两行：名称，下面是完整的网址 / 路径。点一下直接打开，鼠标移上去可以复制、看详情（右侧面板）。
   - 任何一条都能拖：在组里换位置、拖到别的分组；自己建的分组拖标题换先后。顺序记在条目的 rank 上，跟着数据同步。
   算法在 lib/linkOrder.ts。 */
import { Copy, Disc, Folder, FolderPlus, Globe, Monitor, PanelRight, Pin, Plus, Server, Tag, X } from "lucide-react";
import { useEffect, useMemo, useState, type DragEvent } from "react";
import { create } from "zustand";
import { copyText, errText, openTarget } from "../lib/api";
import { cx } from "../lib/cx";
import { patchItem, qc, useAppState, useDevices } from "../lib/data";
import { buildGroups, planGroupMove, planMove, type LinkGroup, type LinkPatch } from "../lib/linkOrder";
import { deviceByHost, devOnline, entryTargets, hostOf, normCat, type HostKind } from "../lib/logic";
import { ls, useUi } from "../lib/store";
import type { Item, State } from "../lib/types";
import { Filters } from "./Filters";
import { bumpLink } from "./Home";
import { Elsewhere, useFilter } from "./ListPane";
import { Button } from "./ui";

const HOST_ICON: Record<HostKind, typeof Monitor> = { pc: Monitor, server: Server, web: Globe, disk: Disc, other: Folder };

async function open(it: Item, target: string) {
  const say = useUi.getState().say;
  try {
    bumpLink(it.id);
    const how = await openTarget(target);
    say(how === "copied" ? "网页版不能直接打开本地路径，已复制：" + target : "已打开：" + it.title);
  } catch (e) {
    say(errText(e));
  }
}

/* ---- 还没有内容的分组：只记在这台电脑上，拖进去一条之后它就是那条的分类了 ---- */
const EMPTY_KEY = "wb-link-groups";
const loadEmpty = (): string[] => {
  try {
    const v = JSON.parse(ls.get(EMPTY_KEY) || "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
};

/* ---- 拖动 ---- */
const DND = "application/x-xpanel-link";
let dragging: { type: "item" | "group"; id: string } | null = null;
type Over = { group: string; id?: string; after?: boolean } | null;
const useOver = create<{ over: Over }>(() => ({ over: null }));
const setOver = (o: Over) => {
  const c = useOver.getState().over;
  if (c?.group !== o?.group || c?.id !== o?.id || c?.after !== o?.after) useOver.setState({ over: o });
};
const endDrag = () => {
  dragging = null;
  setOver(null);
};
async function applyPatches(ps: LinkPatch[]) {
  if (!ps.length) return;
  const all = qc.getQueryData<State>(["state"])?.items ?? [];
  // 每条只发改了的字段；失败时 patchItem 自己会提示并重新拉数据
  await Promise.all(
    ps.map((p) => {
      const it = all.find((x) => x.id === p.id);
      return it ? patchItem(it, p.set as Partial<Item>) : null;
    }),
  ).catch(() => {});
}

const mini = "grid size-7 shrink-0 place-items-center rounded-md text-muted hover:bg-surface-3 hover:text-fg [&_svg]:size-3.5";

function Row({ it, group, canDrag, onDropAt, keep }: { it: Item; group: string; canDrag: boolean; onDropAt: (group: string, before: string | null) => void; keep?: string }) {
  const ui = useUi();
  const mark = useOver((s) => (s.over?.id === it.id ? (s.over.after ? "after" : "before") : null));
  // 另外写的地址最多给两个按钮，再多的在详情里
  const [first, ...rest] = entryTargets(it);
  const more = rest.slice(0, 2);
  const Icon = HOST_ICON[hostOf(first ?? null).kind];
  return (
    <div
      data-item-id={it.id}
      draggable={canDrag}
      onDragStart={(e: DragEvent) => {
        e.stopPropagation();
        dragging = { type: "item", id: it.id };
        e.dataTransfer.setData(DND, it.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragEnd={endDrag}
      onDragOver={(e: DragEvent) => {
        // 拖的是整个分组：交给外面的卡片处理
        if (!dragging || dragging.type === "group") return;
        e.preventDefault();
        e.stopPropagation();
        if (dragging.id === it.id) return setOver(null);
        const r = e.currentTarget.getBoundingClientRect();
        setOver({ group, id: it.id, after: e.clientY > r.top + r.height / 2 });
      }}
      onDrop={(e: DragEvent) => {
        if (!dragging || dragging.type === "group") return;
        e.preventDefault();
        e.stopPropagation();
        if (dragging.id === it.id) return endDrag();
        const o = useOver.getState().over;
        if (o?.id !== it.id) return onDropAt(group, null);
        // 落在下半截：排到它后面，也就是它下一条的前面
        const sib = e.currentTarget.nextElementSibling as HTMLElement | null;
        onDropAt(group, o.after ? sib?.dataset.itemId || null : it.id);
      }}
      className={cx(
        "group relative flex min-w-0 break-inside-avoid items-start gap-0.5 rounded-xl py-1.5 pr-1 hover:bg-surface-2",
        keep,
        mark === "before" && "shadow-[inset_0_2px_0_0_var(--accent)]",
        mark === "after" && "shadow-[inset_0_-2px_0_0_var(--accent)]",
      )}
    >
      <button className="flex min-w-0 grow items-start gap-2 pl-2.5 text-left" style={more.length ? { paddingRight: more.length * 28 } : undefined} title={first ? "点击打开" : "还没填网址或路径，点开填上"} onClick={() => (first ? open(it, first) : ui.openPeek(it.id, "edit"))}>
        {it.pinned ? <Pin className="mt-[3px] size-3.5 shrink-0 text-accent" /> : <Icon className="mt-[3px] size-3.5 shrink-0 text-muted" />}
        <span className="flex min-w-0 flex-col">
          <span className="text-sm leading-5 break-words text-fg">{it.title || first || "没有名称"}</span>
          {first !== it.title && <span className={cx("line-clamp-3 font-mono text-xs leading-[1.45] break-all", first ? "text-muted" : "text-faint")}>{first || "还没填网址或路径"}</span>}
        </span>
      </button>
      {/* 右上角：另外写的地址一直在；复制、详情鼠标移上来才出现，浮着不占正文的宽度 */}
      <span className="absolute top-1 right-1 flex">
        <span className="flex rounded-lg bg-surface-2 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
          {first && (
            <button className={mini} aria-label={"复制 " + it.title} title="复制网址 / 路径" onClick={async () => ui.say((await copyText(first)) ? "已复制：" + first : "复制失败")}>
              <Copy />
            </button>
          )}
          <button className={mini} aria-label={"详情 " + it.title} title="在右侧看和改（备注、分类、项目…）" onClick={() => ui.openPeek(it.id)}>
            <PanelRight />
          </button>
        </span>
        {more.map((t) => {
          const I = HOST_ICON[hostOf(t).kind];
          return (
            <button key={t} className={mini} aria-label={"打开 " + t} title={"也可以打开：" + t} onClick={() => open(it, t)}>
              <I />
            </button>
          );
        })}
      </span>
    </div>
  );
}

function GroupCard({
  g,
  canDrag,
  onDropAt,
  onDropGroup,
  onRemove,
}: {
  g: LinkGroup;
  canDrag: boolean;
  onDropAt: (group: string, before: string | null) => void;
  onDropGroup: (onto: string) => void;
  onRemove?: () => void;
}) {
  const devices = useDevices();
  const hot = useOver((s) => s.over?.group === g.key && !s.over.id);
  const Icon = g.kind ? HOST_ICON[g.kind] : Tag;
  const host = g.key.replace(/^auto:/, "");
  const dv = g.kind === "pc" || g.kind === "server" ? deviceByHost(devices, host) : undefined;
  const name = g.cat !== null ? g.cat.split("/").join(" / ") : dv?.name || host;
  const movable = canDrag && g.cat !== null && g.items.length > 0;
  // 条目多的分组可以在两列之间断开接着排（每一段都画成一张卡片），整页几列差不多一样高、不留大块空白；
  // 条目少的整张放在一列里。以前多的那张横跨整行，会把前后的分组挤成只占一列，旁边空一大片
  const long = g.items.length > 6;
  return (
    <section
      aria-label={name}
      onDragOver={(e: DragEvent) => {
        if (!dragging || (dragging.type === "group" && dragging.id === g.key)) return;
        e.preventDefault();
        setOver({ group: g.key });
      }}
      onDrop={(e: DragEvent) => {
        if (!dragging) return;
        e.preventDefault();
        if (dragging.type === "group") onDropGroup(g.key);
        else onDropAt(g.key, null);
      }}
      className={cx(
        "mb-3 rounded-[18px] p-2.5 transition-colors [-webkit-box-decoration-break:clone] [box-decoration-break:clone]",
        hot ? "bg-accent-soft" : "bg-surface",
        !long && "break-inside-avoid",
      )}
    >
      <h2
        draggable={movable}
        onDragStart={(e: DragEvent) => {
          dragging = { type: "group", id: g.key };
          e.dataTransfer.setData(DND, g.key);
          e.dataTransfer.effectAllowed = "move";
        }}
        onDragEnd={endDrag}
        title={g.cat === null ? "没归到分组的，按所在的机器自动分" : movable ? "拖动换分组的先后" : undefined}
        className={cx("flex h-8 break-after-avoid items-center gap-1.5 px-2.5 text-[13px] font-semibold [&_svg]:size-3.5", g.cat === null ? "text-muted" : "text-fg", movable && "cursor-grab")}
      >
        <Icon className={g.cat === null ? "text-link" : "text-accent"} />
        {dv && <span className={cx("size-1.5 rounded-full", devOnline(dv) ? "bg-ok" : "bg-faint")} title={devOnline(dv) ? "在线" : "不在线"} />}
        <span className="min-w-0 truncate">{name}</span>
        {dv && dv.name.toUpperCase() !== host && <span className="font-normal text-faint">{host}</span>}
        <span className="text-xs font-normal text-faint">{g.items.length || ""}</span>
        <span className="grow" />
        {onRemove && (
          <button className={mini} aria-label={"去掉分组 " + name} title="去掉这个空分组" onClick={onRemove}>
            <X />
          </button>
        )}
      </h2>
      <div className="[&>*+*]:mt-0.5">
        {g.items.map((it, i) => (
          // 分组在两列之间断开时，标题后面至少跟三条、接到下一列的至少两条，不会只剩孤零零的一条
          <Row key={it.id} it={it} group={g.key} canDrag={canDrag} onDropAt={onDropAt} keep={cx(i < 2 && "break-after-avoid", i >= g.items.length - 2 && "break-before-avoid")} />
        ))}
      </div>
      {!g.items.length && <p className="px-2.5 pb-2 text-xs text-faint">空的。把入口拖到这里。</p>}
    </section>
  );
}

export function Links() {
  const items = useAppState().data?.items ?? [];
  const ui = useUi();
  const match = useFilter();
  const filtering = !!(ui.q || ui.tag || ui.dev || ui.cat || ui.proj);
  const [empty, setEmpty] = useState(loadEmpty);
  const [naming, setNaming] = useState<string | null>(null);
  const saveEmpty = (next: string[]) => {
    setEmpty(next);
    ls.set(EMPTY_KEY, next.length ? JSON.stringify(next) : null);
  };

  // 从别处跳到某个入口（搜索、新建完）：这里没有阅读栏，在右侧面板里打开
  const sel = ui.selected.links;
  useEffect(() => {
    if (!sel) return;
    ui.select(null);
    if (items.some((i) => i.id === sel)) ui.openPeek(sel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel]);

  const [groups, count] = useMemo(() => {
    const list = items.filter((i) => i.type === "link" && match(i));
    return [buildGroups(list, filtering ? [] : empty), list.length] as const;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, empty, ui.cat, ui.tag, ui.q, ui.dev, ui.proj]);
  // 分组里有了内容，就不用再单独记着它
  useEffect(() => {
    const used = new Set(items.filter((i) => i.type === "link" && i.category).map((i) => i.category));
    if (empty.some((c) => used.has(c))) saveEmpty(empty.filter((c) => !used.has(c)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  // 筛选着的时候看到的不是全部，拖动排序会把没显示的挤乱，所以不让拖
  const canDrag = !filtering;
  const onDropAt = (group: string, before: string | null) => {
    const d = dragging;
    endDrag();
    if (d?.type === "item") applyPatches(planMove(groups, d.id, group, before));
  };
  const onDropGroup = (onto: string) => {
    const d = dragging;
    endDrag();
    if (d?.type !== "group" || d.id === onto) return;
    // 往后拖：排到它后面；往前拖：排到它前面
    const from = groups.findIndex((g) => g.key === d.id);
    const to = groups.findIndex((g) => g.key === onto);
    applyPatches(planGroupMove(groups, d.id, from < to ? (groups[to + 1]?.key ?? null) : onto));
  };
  const addGroup = () => {
    const name = normCat(naming || "");
    setNaming(null);
    if (!name) return;
    if (groups.some((g) => g.cat === name)) return ui.say(`已经有「${name.split("/").join(" / ")}」这个分组了`);
    saveEmpty([...empty, name]);
  };

  return (
    <main aria-label="入口" className="scroll-quiet flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto pb-20" onDragEnd={endDrag}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-1">
        <h1 className="text-[19px] font-bold">入口</h1>
        <span className="text-[13px] text-muted">
          {count} 条 · 点一下直接打开{canDrag ? "，按住可以拖到别的位置或分组" : "（筛选时不能拖动）"}
        </span>
        <span className="grow" />
        <Filters />
        {naming === null ? (
          <Button onClick={() => setNaming("")} disabled={filtering} title="建一个自己的分组，再把入口拖进去">
            <FolderPlus className="size-4" />
            新建分组
          </Button>
        ) : (
          <input
            autoFocus
            aria-label="分组名称"
            value={naming}
            onChange={(e) => setNaming(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addGroup();
              if (e.key === "Escape") setNaming(null);
            }}
            onBlur={addGroup}
            placeholder="分组名称，回车确定"
            className="h-[34px] w-52 rounded-[10px] bg-surface px-3 text-[13px] outline-none placeholder:text-faint"
          />
        )}
        <Button tone="primary" onClick={() => ui.focusCapture("link")} title="在快速记录里贴一个网址或路径">
          <Plus className="size-4" />
          新建
        </Button>
      </div>
      <Elsewhere />
      {groups.length > 0 && (
        <div className="shrink-0 columns-[380px] gap-x-3">
          {groups.map((g) => (
            <GroupCard
              key={g.key}
              g={g}
              canDrag={canDrag}
              onDropAt={onDropAt}
              onDropGroup={onDropGroup}
              onRemove={g.cat !== null && !g.items.length ? () => saveEmpty(empty.filter((c) => c !== g.cat)) : undefined}
            />
          ))}
        </div>
      )}
      {!groups.length && (
        <p className="rounded-[18px] bg-surface px-5 py-8 text-center text-[13px] text-faint">
          {filtering ? "没有匹配的入口" : "还没有入口。在右下角的快速记录里选「入口」，贴一个网址、共享文件夹或本地路径就能加进来。"}
        </p>
      )}
    </main>
  );
}
