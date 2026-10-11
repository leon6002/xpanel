/* 入口页：一整屏的密集列表，不分左右栏。按所在的机器分组，所有分组顺着排成几列；
   点一行直接打开（常点的排前面），鼠标移上去可以复制、看详情（右侧面板里看和改）。
   一个入口里除了第一个网址 / 路径还写了别的（比如仓库的网址之外还有本地文件夹），在这一行后面多出小按钮。 */
import { Copy, Disc, Folder, Globe, Monitor, PanelRight, Pin, Plus, Server } from "lucide-react";
import { useEffect, useMemo } from "react";
import { copyText, errText, openTarget } from "../lib/api";
import { cx } from "../lib/cx";
import { useAppState, useDevices } from "../lib/data";
import { deviceByHost, devOnline, entryTargets, hostOf, type HostKind } from "../lib/logic";
import { useUi } from "../lib/store";
import type { Item } from "../lib/types";
import { Filters } from "./Filters";
import { bumpLink, linkUsage } from "./Home";
import { Elsewhere, useFilter } from "./ListPane";
import { Button } from "./ui";

const HOST_ICON: Record<HostKind, typeof Monitor> = { pc: Monitor, server: Server, web: Globe, disk: Disc, other: Folder };
const ORDER: Record<HostKind, number> = { pc: 0, server: 1, disk: 2, web: 3, other: 4 };
/** 网址去掉 https://，路径原样：一行里能多看到点有用的 */
const short = (t: string) => t.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, "");

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

const mini = "grid size-7 shrink-0 place-items-center rounded-md text-muted hover:bg-surface-3 hover:text-fg [&_svg]:size-3.5";

function Row({ it }: { it: Item }) {
  const ui = useUi();
  const [first, ...more] = entryTargets(it);
  const Icon = HOST_ICON[hostOf(first ?? null).kind];
  return (
    <div data-item-id={it.id} className="group flex h-9 min-w-0 break-inside-avoid items-center gap-0.5 rounded-xl pr-1 hover:bg-surface-2">
      <button
        className="flex h-full min-w-0 grow items-center gap-2 pl-2.5 text-left"
        title={first ? "点击打开：" + first : "还没填网址或路径，点开填上"}
        onClick={() => (first ? open(it, first) : ui.openPeek(it.id, "edit"))}
      >
        {it.pinned ? <Pin className="size-3.5 shrink-0 text-accent" /> : <Icon className="size-3.5 shrink-0 text-muted" />}
        <span className="max-w-[60%] shrink-0 truncate text-sm text-fg">{it.title || short(first || "")}</span>
        <span className={cx("min-w-0 truncate font-mono text-xs", first ? "text-muted" : "text-faint")}>{first ? short(first) : "还没填网址或路径"}</span>
      </button>
      {more.map((t) => {
        const I = HOST_ICON[hostOf(t).kind];
        return (
          <button key={t} className={mini} aria-label={"打开 " + t} title={"也可以打开：" + t} onClick={() => open(it, t)}>
            <I />
          </button>
        );
      })}
      {first && (
        <button
          className={cx(mini, "opacity-0 group-hover:opacity-100 focus-visible:opacity-100")}
          aria-label={"复制 " + it.title}
          title="复制网址 / 路径"
          onClick={async () => ui.say((await copyText(first)) ? "已复制：" + first : "复制失败")}
        >
          <Copy />
        </button>
      )}
      <button className={cx(mini, "opacity-0 group-hover:opacity-100 focus-visible:opacity-100")} aria-label={"详情 " + it.title} title="在右侧看和改（备注、分类、项目…）" onClick={() => ui.openPeek(it.id)}>
        <PanelRight />
      </button>
    </div>
  );
}

export function Links() {
  const items = useAppState().data?.items ?? [];
  const devices = useDevices();
  const ui = useUi();
  const match = useFilter();
  const filtering = !!(ui.q || ui.tag || ui.dev || ui.cat || ui.proj);

  // 从别处跳到某个入口（搜索、新建完）：这里没有阅读栏，在右侧面板里打开
  const sel = ui.selected.links;
  useEffect(() => {
    if (!sel) return;
    ui.select(null);
    if (items.some((i) => i.id === sel)) ui.openPeek(sel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel]);

  const [groups, count] = useMemo(() => {
    const usage = linkUsage();
    const list = items.filter((i) => i.type === "link" && match(i));
    const by = new Map<string, { key: string; kind: HostKind; items: Item[] }>();
    for (const it of list) {
      const h = hostOf(entryTargets(it)[0] ?? null);
      if (!by.has(h.key)) by.set(h.key, { ...h, items: [] });
      by.get(h.key)!.items.push(it);
    }
    const arr = [...by.values()].sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || a.key.localeCompare(b.key));
    for (const g of arr) g.items.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || (usage[b.id] ?? 0) - (usage[a.id] ?? 0) || a.title.localeCompare(b.title, "zh"));
    return [arr, list.length] as const;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, ui.cat, ui.tag, ui.q, ui.dev, ui.proj]);

  return (
    <main aria-label="入口" className="scroll-quiet flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto pb-20">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-1">
        <h1 className="text-[19px] font-bold">入口</h1>
        <span className="text-[13px] whitespace-nowrap text-muted">{count} 条 · 点一下直接打开</span>
        <span className="grow" />
        <Filters />
        <Button tone="primary" onClick={() => ui.focusCapture("link")} title="在快速记录里贴一个网址或路径">
          <Plus className="size-4" />
          新建
        </Button>
      </div>
      <Elsewhere />
      {groups.length > 0 && (
        // 所有分组顺着排进几列里：只有一两条的分组不用各占一整行
        <div className="shrink-0 rounded-[18px] bg-surface p-3">
          <div className="columns-[300px] gap-x-3">
            {groups.map((g, gi) => {
              const Icon = HOST_ICON[g.kind];
              const dv = g.kind === "pc" || g.kind === "server" ? deviceByHost(devices, g.key) : undefined;
              return (
                <section key={g.key} aria-label={dv?.name || g.key}>
                  <h2 className={cx("flex h-8 break-after-avoid items-center gap-1.5 px-2.5 text-xs font-semibold text-muted [&_svg]:size-3.5", gi > 0 && "mt-2")}>
                    <Icon className="text-link" />
                    {dv ? (
                      <>
                        <span className={cx("size-1.5 rounded-full", devOnline(dv) ? "bg-ok" : "bg-faint")} title={devOnline(dv) ? "在线" : "不在线"} />
                        {dv.name}
                        {dv.name.toUpperCase() !== g.key && <span className="font-normal text-faint">{g.key}</span>}
                      </>
                    ) : (
                      g.key
                    )}
                    <span className="font-normal text-faint">{g.items.length}</span>
                  </h2>
                  {g.items.map((it) => (
                    <Row key={it.id} it={it} />
                  ))}
                </section>
              );
            })}
          </div>
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
