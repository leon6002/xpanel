import { FileText, Inbox, Link2, SquareCheck, SunMoon, Sun, Moon } from "lucide-react";
import { useMemo } from "react";
import { isApp } from "../lib/api";
import { useAppState } from "../lib/data";
import { allCats, allTags } from "../lib/logic";
import { useUi, type View } from "../lib/store";
import { cx } from "../lib/cx";

const NAV: { k: View; name: string; icon: typeof Inbox }[] = [
  { k: "inbox", name: "收件箱", icon: Inbox },
  { k: "work", name: "事项", icon: SquareCheck },
  { k: "notes", name: "笔记", icon: FileText },
  { k: "links", name: "入口", icon: Link2 },
];

export function Sidebar() {
  const { data } = useAppState();
  const items = data?.items ?? [];
  const ui = useUi();
  const counts: Record<View, number> = {
    inbox: items.filter((i) => i.type === "inbox").length,
    work: items.filter((i) => ["todo", "issue", "idea"].includes(i.type) && !i.done).length,
    notes: items.filter((i) => i.type === "note").length,
    links: items.filter((i) => i.type === "link").length,
  };
  const cats = useMemo(() => allCats(items, data?.categories ?? []), [items, data?.categories]);
  const tags = useMemo(() => allTags(items).slice(0, 16), [items]);
  const catCount = (p: string) => items.filter((i) => i.category === p || i.category?.startsWith(p + "/")).length;
  const online = (data?.devices ?? []).filter((d) => d.lastSeen && Date.now() - d.lastSeen < 180000);
  const ThemeIcon = ui.theme === "light" ? Sun : ui.theme === "dark" ? Moon : SunMoon;

  return (
    <nav aria-label="主导航" className="flex w-[220px] shrink-0 flex-col gap-5 px-1.5 py-2.5">
      <div className="flex items-center gap-2.5 px-2.5">
        <span className="grid size-[30px] place-items-center rounded-[9px] bg-accent text-[15px] font-bold text-on-accent">x</span>
        <span className="text-[17px] font-bold">xpanel</span>
      </div>

      <div className="flex flex-col gap-1">
        {NAV.map(({ k, name, icon: Icon }) => (
          <button
            key={k}
            aria-current={ui.view === k ? "page" : undefined}
            onClick={() => ui.setView(k)}
            className={cx(
              "flex h-10 items-center gap-2.5 rounded-[10px] px-3 text-left text-sm transition-colors [&_svg]:size-[18px]",
              ui.view === k ? "bg-surface font-semibold text-fg shadow-1 [&_svg]:text-accent" : "text-fg-2 hover:bg-surface/60",
            )}
          >
            <Icon strokeWidth={1.8} />
            <span className="grow">{name}</span>
            {k === "inbox" && counts.inbox > 0 ? (
              <span className="grid h-5 min-w-5 place-items-center rounded-full bg-accent px-1.5 text-xs font-normal text-on-accent">{counts.inbox}</span>
            ) : (
              <span className="text-xs font-normal text-muted">{counts[k] || ""}</span>
            )}
          </button>
        ))}
      </div>

      <div className="scroll-quiet flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto">
        <div className="flex flex-col gap-0.5">
          <div className="px-3 pb-1.5 text-xs text-muted">分类</div>
          <button
            onClick={() => ui.setCat(null)}
            className={cx("flex h-[34px] items-center justify-between rounded-lg px-3 text-[13.5px]", !ui.cat ? "bg-accent-soft font-semibold text-accent-strong" : "text-fg-2 hover:bg-surface/60")}
          >
            <span>全部</span>
          </button>
          {cats.map((p) => {
            const depth = p.split("/").length - 1;
            const on = ui.cat === p;
            return (
              <button
                key={p}
                onClick={() => ui.setCat(on ? null : p)}
                style={{ paddingLeft: 12 + depth * 16 }}
                className={cx("flex h-[34px] items-center justify-between rounded-lg pr-3 text-[13.5px]", on ? "bg-accent-soft font-semibold text-accent-strong" : "text-fg-2 hover:bg-surface/60")}
              >
                <span className="truncate">{p.split("/").pop()}</span>
                <span className={cx("text-xs", on ? "" : "text-muted")}>{catCount(p) || ""}</span>
              </button>
            );
          })}
          <button
            onClick={() => ui.setCat(ui.cat === "none" ? null : "none")}
            className={cx("flex h-[34px] items-center rounded-lg px-3 text-[13.5px]", ui.cat === "none" ? "bg-accent-soft font-semibold text-accent-strong" : "text-muted hover:bg-surface/60")}
          >
            未分类
          </button>
        </div>
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-3">
            {tags.map(([t]) => (
              <button
                key={t}
                onClick={() => ui.setTag(ui.tag === t ? null : t)}
                className={cx("rounded-full px-2.5 py-0.5 text-xs", ui.tag === t ? "bg-accent text-on-accent" : "bg-surface text-fg-2 hover:text-fg")}
              >
                #{t}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 rounded-xl bg-surface px-3 py-2.5 text-[12.5px] text-fg-2">
        <span className={cx("size-2 rounded-full", data?.offline ? "bg-warn" : "bg-ok")} />
        <span className="grow truncate">
          {data?.offline ? `离线 · ${data.pending || 0} 条待上传` : isApp ? `已连接 · ${online.length} 台在线` : `网页版 · ${online.length} 台在线`}
        </span>
        <button onClick={ui.cycleTheme} aria-label="切换外观" title="切换外观" className="grid size-7 place-items-center rounded-md text-muted hover:bg-surface-3 hover:text-fg [&_svg]:size-4">
          <ThemeIcon />
        </button>
      </div>
    </nav>
  );
}
