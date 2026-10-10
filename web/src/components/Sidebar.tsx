/* 左侧窄栏：搜索、各页面的入口、设备、同步、设置、外观。
   分类、标签、按设备筛选不在这里了，挪到各页面列表上方的「筛选」（components/Filters.tsx）。 */
import { BookMarked, FileText, HardDrive, House, Inbox, KeyRound, Link2, MonitorSmartphone, Moon, Search, Settings2, SquareCheck, Sun, SunMoon } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { isApp } from "../lib/api";
import { useAppState, useChats, useConfig } from "../lib/data";
import { devOnline } from "../lib/logic";
import { useUi, type View } from "../lib/store";
import { VAULT_KEY, fetchVault } from "../lib/vault";
import { cx } from "../lib/cx";
import { openPalette } from "./Palette";
import { openDevices } from "../dialogs/Devices";
import { openSettings } from "../dialogs/Settings";
import { openDriveSync } from "../dialogs/DriveSync";

const NAV: { k: View; name: string; icon: typeof Inbox }[] = [
  { k: "home", name: "首页", icon: House },
  { k: "inbox", name: "收件箱", icon: Inbox },
  { k: "work", name: "事项", icon: SquareCheck },
  { k: "notes", name: "笔记", icon: FileText },
  { k: "links", name: "入口", icon: Link2 },
  { k: "rules", name: "规范", icon: BookMarked },
  { k: "vault", name: "密码库", icon: KeyRound },
];

const railBtn = "relative grid size-10 place-items-center rounded-xl transition-colors [&_svg]:size-[19px]";
const smallBtn = "grid size-9 place-items-center rounded-lg text-muted hover:bg-surface-3 hover:text-fg [&_svg]:size-[17px]";

export function Sidebar() {
  const { data, error } = useAppState();
  const items = data?.items ?? [];
  const devices = data?.devices ?? [];
  const chats = useChats().data ?? [];
  const cfg = useConfig().data;
  const ui = useUi();

  // 角标：收件箱里没处理的、密码库里随手记下还没整理的
  const rawCount = (useQuery({ queryKey: VAULT_KEY, queryFn: fetchVault, enabled: !!data }).data?.secrets ?? []).filter((x) => x.kind === "raw").length;
  const badge: Partial<Record<View, number>> = {
    inbox: items.filter((i) => i.type === "inbox").length + chats.reduce((n, c) => n + (c.unread || 0), 0),
    vault: rawCount,
  };
  const count: Partial<Record<View, number>> = {
    work: items.filter((i) => ["todo", "issue", "idea"].includes(i.type) && !i.done).length,
    notes: items.filter((i) => i.type === "note").length,
    links: items.filter((i) => i.type === "link").length,
    rules: items.filter((i) => i.type === "rule").length,
  };
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
  const online = devices.filter(devOnline).length;

  return (
    <nav aria-label="主导航" className="flex w-12 shrink-0 flex-col items-center gap-3 py-1">
      <span className="grid size-[30px] place-items-center rounded-[9px] bg-ink text-[15px] font-bold text-on-ink" title="xpanel">
        x
      </span>
      <button onClick={openPalette} title="搜全部：事项、笔记、消息、入口、密码库（Ctrl+K）" aria-label="搜索全部" className={cx(railBtn, "bg-surface-2 text-muted hover:bg-surface-3 hover:text-fg")}>
        <Search />
      </button>
      <div className="flex flex-col gap-1">
        {NAV.map(({ k, name, icon: Icon }) => (
          <button
            key={k}
            aria-current={ui.view === k ? "page" : undefined}
            aria-label={name}
            onClick={() => ui.setView(k)}
            title={count[k] ? `${name}（${count[k]}）` : name}
            className={cx(railBtn, ui.view === k ? "bg-surface-3 text-fg" : "text-fg-2 hover:bg-surface-2")}
          >
            <Icon strokeWidth={1.8} />
            {!!badge[k] && <span className="absolute -top-0.5 -right-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-accent-soft px-1 text-[10px] font-semibold text-accent-strong">{badge[k]}</span>}
          </button>
        ))}
      </div>
      <span className="grow" />
      <div className="flex flex-col items-center gap-0.5">
        <button onClick={() => openDevices()} aria-label="设备" title={`设备：${online}/${devices.length} 台在线`} className={cx(smallBtn, "relative")}>
          <MonitorSmartphone />
          {online > 0 && <span className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-ok" />}
        </button>
        <button onClick={() => openDriveSync()} aria-label="外置硬盘同步" title="外置硬盘同步（换电脑、带着数据出差）" className={smallBtn}>
          <HardDrive />
        </button>
        <button onClick={ui.cycleTheme} aria-label="切换外观" title="切换外观" className={smallBtn}>
          <ThemeIcon />
        </button>
        <button onClick={() => openSettings()} aria-label="设置" title={`${conn.text} · ${isApp ? "连接与设置" : "网页版设置"}`} className={cx(smallBtn, "relative")}>
          <Settings2 />
          <span className={cx("absolute top-1.5 right-1.5 size-1.5 rounded-full", conn.dot)} />
        </button>
      </div>
    </nav>
  );
}
