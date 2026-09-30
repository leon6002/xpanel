/* 左侧：导航、分类树、标签、设备、连接状态和外观 */
import { BookMarked, ChevronDown, ChevronRight, FileText, Inbox, Link2, Moon, Plus, Settings2, SquareCheck, Sun, SunMoon, Tags, MonitorSmartphone } from "lucide-react";
import { useMemo, useState } from "react";
import { isApp } from "../lib/api";
import { useAppState, useChats, useConfig, useThisDevice } from "../lib/data";
import { allCats, allTags, devOnline, inCat, parentCat } from "../lib/logic";
import { ls, useUi, type View } from "../lib/store";
import { cx } from "../lib/cx";
import { openCatMgr } from "../dialogs/Categories";
import { openDevices } from "../dialogs/Devices";
import { openSettings } from "../dialogs/Settings";

const NAV: { k: View; name: string; icon: typeof Inbox }[] = [
  { k: "inbox", name: "收件箱", icon: Inbox },
  { k: "work", name: "事项", icon: SquareCheck },
  { k: "notes", name: "笔记", icon: FileText },
  { k: "links", name: "入口", icon: Link2 },
  { k: "rules", name: "规范", icon: BookMarked },
];

function greet() {
  const d = new Date();
  const h = d.getHours();
  return `${d.getMonth() + 1}月${d.getDate()}日 · 星期${"日一二三四五六"[d.getDay()]} · ${h < 6 ? "夜深了" : h < 11 ? "早上好" : h < 14 ? "中午好" : h < 18 ? "下午好" : "晚上好"}`;
}

const secH = "flex items-center gap-1 px-3 pb-1 text-xs text-muted";
const miniBtn = "grid size-6 place-items-center rounded-md text-faint hover:bg-surface-3 hover:text-fg [&_svg]:size-3.5";

export function Sidebar() {
  const { data, error } = useAppState();
  const items = data?.items ?? [];
  const devices = data?.devices ?? [];
  const chats = useChats().data ?? [];
  const cfg = useConfig().data;
  const me = useThisDevice();
  const ui = useUi();
  const [closed, setClosed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(ls.get("wb-catclosed") || "[]"));
    } catch {
      return new Set();
    }
  });
  const toggle = (p: string) => {
    const n = new Set(closed);
    if (n.has(p)) n.delete(p);
    else n.add(p);
    setClosed(n);
    ls.set("wb-catclosed", JSON.stringify([...n]));
  };

  const counts: Record<View, number> = {
    inbox: items.filter((i) => i.type === "inbox").length + chats.reduce((n, c) => n + (c.unread || 0), 0),
    work: items.filter((i) => ["todo", "issue", "idea"].includes(i.type) && !i.done).length,
    notes: items.filter((i) => i.type === "note").length,
    links: items.filter((i) => i.type === "link").length,
    rules: items.filter((i) => i.type === "rule").length,
  };
  const cats = useMemo(() => allCats(items, data?.categories ?? []), [items, data?.categories]);
  const tags = useMemo(() => allTags(items).slice(0, 24), [items]);
  const catCount = (p: string) => items.filter((i) => inCat(i.category, p)).length;
  const kids = (p: string) => cats.filter((c) => parentCat(c) === p);
  const ThemeIcon = ui.theme === "light" ? Sun : ui.theme === "dark" ? Moon : SunMoon;

  const conn = error
    ? { dot: "bg-danger", text: "连接出错" }
    : data?.offline
      ? { dot: "bg-warn", text: data.pending ? `离线 · ${data.pending} 条待上传` : "离线 · 显示缓存" }
      : !isApp
        ? { dot: "bg-ok", text: "网页版 · 已连接" }
        : cfg?.config.mode === "host"
          ? { dot: "bg-ok", text: cfg.lan?.running ? "本机存储 · 局域网已开放" : "本机存储" }
          : { dot: "bg-ok", text: "已连接主机" };

  const node = (p: string, depth: number): React.ReactNode => {
    const ch = kids(p);
    const open = !closed.has(p);
    const on = ui.cat === p;
    return (
      <div key={p}>
        <div
          style={{ paddingLeft: 4 + depth * 14 }}
          className={cx("flex h-[32px] items-center rounded-lg pr-3 text-[13.5px]", on ? "bg-surface-3 font-medium text-fg" : "text-fg-2 hover:bg-surface-2")}
        >
          <button
            aria-label={open ? "收起" : "展开"}
            className={cx("grid size-5 shrink-0 place-items-center text-faint [&_svg]:size-3.5", !ch.length && "invisible")}
            onClick={() => toggle(p)}
          >
            {open ? <ChevronDown /> : <ChevronRight />}
          </button>
          <button onClick={() => ui.setCat(on ? null : p)} className="flex min-w-0 grow items-center justify-between text-left" title={p}>
            <span className="truncate">{p.split("/").pop()}</span>
            <span className={cx("text-xs", on ? "" : "text-muted")}>{catCount(p) || ""}</span>
          </button>
        </div>
        {open && ch.map((c) => node(c, depth + 1))}
      </div>
    );
  };

  return (
    <nav aria-label="主导航" className="flex w-[228px] shrink-0 flex-col gap-4 px-1.5 py-2.5 max-[1200px]:w-14 max-[1200px]:px-0">
      <div className="flex flex-col gap-1 px-2.5 max-[1200px]:px-[13px]">
        <div className="flex items-center gap-2.5">
          <span className="grid size-[30px] place-items-center rounded-[9px] bg-ink text-[15px] font-bold text-on-ink">x</span>
          <span className="text-[17px] font-bold max-[1200px]:hidden">xpanel</span>
        </div>
        <span className="text-xs text-muted max-[1200px]:hidden">{greet()}</span>
      </div>

      <div className="flex flex-col gap-1">
        {NAV.map(({ k, name, icon: Icon }) => (
          <button
            key={k}
            aria-current={ui.view === k ? "page" : undefined}
            onClick={() => ui.setView(k)}
            title={name}
            className={cx(
              "relative flex h-9 items-center gap-2.5 rounded-lg px-3 text-left text-sm transition-colors max-[1200px]:justify-center max-[1200px]:px-0 [&_svg]:size-[18px]",
              ui.view === k ? "bg-surface-3 font-medium text-fg" : "text-fg-2 hover:bg-surface-2",
            )}
          >
            <Icon strokeWidth={1.8} />
            <span className="grow max-[1200px]:hidden">{name}</span>
            {k === "inbox" && counts.inbox > 0 ? (
              <span className="grid h-5 min-w-5 place-items-center rounded-full bg-accent-soft px-1.5 text-xs font-semibold text-accent-strong max-[1200px]:absolute max-[1200px]:-top-1 max-[1200px]:right-0 max-[1200px]:h-4 max-[1200px]:min-w-4 max-[1200px]:px-1 max-[1200px]:text-[10px]">
                {counts.inbox}
              </span>
            ) : (
              <span className="text-xs font-normal text-muted max-[1200px]:hidden">{counts[k] || ""}</span>
            )}
          </button>
        ))}
      </div>

      <div className="scroll-quiet -mr-1.5 flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto pr-1.5 max-[1200px]:invisible">
        {ui.view !== "inbox" && (
          <>
            <div className="flex flex-col gap-0.5">
              <div className={secH}>
                分类
                <span className="grow" />
                <button className={miniBtn} title="新建分类" aria-label="新建分类" onClick={() => openCatMgr(true)}>
                  <Plus />
                </button>
                <button className={miniBtn} title="管理分类和标签" aria-label="管理分类和标签" onClick={() => openCatMgr()}>
                  <Settings2 />
                </button>
              </div>
              <button
                onClick={() => ui.setCat(null)}
                className={cx("flex h-[32px] items-center rounded-lg px-3 text-[13.5px]", !ui.cat ? "bg-surface-3 font-medium text-fg" : "text-fg-2 hover:bg-surface-2")}
              >
                全部
              </button>
              {kids("").map((p) => node(p, 0))}
              <button
                onClick={() => ui.setCat(ui.cat === "none" ? null : "none")}
                className={cx("flex h-[32px] items-center rounded-lg px-3 text-[13.5px]", ui.cat === "none" ? "bg-surface-3 font-medium text-fg" : "text-muted hover:bg-surface-2")}
              >
                未分类
              </button>
            </div>
            {tags.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <div className={secH}>
                  <Tags className="size-3.5" /> 标签
                </div>
                <div className="flex flex-wrap gap-1.5 px-3">
                  {tags.map(([t, n]) => (
                    <button
                      key={t}
                      onClick={() => ui.setTag(ui.tag === t ? null : t)}
                      title={`${n} 条`}
                      className={cx("rounded-full px-2.5 py-0.5 text-xs", ui.tag === t ? "bg-ink text-on-ink" : "bg-surface-2 text-fg-2 hover:bg-surface-3 hover:text-fg")}
                    >
                      #{t}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
        <div className="flex flex-col gap-0.5">
          <div className={secH}>
            <MonitorSmartphone className="size-3.5" /> 设备
            <span className="font-normal">
              {devices.filter(devOnline).length}/{devices.length}
            </span>
            <span className="grow" />
            <button className={miniBtn} title="设备管理" aria-label="设备管理" onClick={() => openDevices()}>
              <Settings2 />
            </button>
          </div>
          {devices.map((d) => {
            const on = ui.dev === d.name;
            return (
              <button
                key={d.id}
                onClick={() => ui.setDev(on ? null : d.name)}
                title={on ? "取消按设备筛选" : "只看和这台有关的"}
                className={cx("flex h-[30px] items-center gap-2 rounded-lg px-3 text-[13px]", on ? "bg-surface-3 font-medium text-fg" : "text-fg-2 hover:bg-surface-2")}
              >
                <span className={cx("size-1.5 shrink-0 rounded-full", devOnline(d) ? "bg-ok" : "bg-line")} />
                <span className="truncate">{d.name}</span>
                {d.id === me.id && <span className="rounded bg-surface-3 px-1 text-[10.5px] font-normal text-muted">本机</span>}
              </button>
            );
          })}
          {!devices.length && <div className="px-3 text-xs text-faint">还没有设备</div>}
        </div>
      </div>

      <div className="flex items-center gap-1 rounded-lg py-1.5 pr-1.5 pl-3 text-[12.5px] text-fg-2 max-[1200px]:flex-col max-[1200px]:p-1.5">
        <button className="flex min-w-0 grow items-center gap-2 text-left" onClick={() => openSettings()} title={isApp ? "连接与设置" : "网页版设置"}>
          <span className={cx("size-2 shrink-0 rounded-full", conn.dot)} />
          <span className="truncate max-[1200px]:hidden" title={conn.text}>
            {conn.text}
          </span>
        </button>
        <button onClick={() => openSettings()} aria-label="设置" title="设置" className="grid size-7 place-items-center rounded-md text-muted hover:bg-surface-3 hover:text-fg [&_svg]:size-4">
          <Settings2 />
        </button>
        <button onClick={ui.cycleTheme} aria-label="切换外观" title="切换外观" className="grid size-7 place-items-center rounded-md text-muted hover:bg-surface-3 hover:text-fg [&_svg]:size-4">
          <ThemeIcon />
        </button>
      </div>
    </nav>
  );
}
