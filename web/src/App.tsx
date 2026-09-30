/* 界面骨架：左侧导航 · 中间列表 · 右边阅读（收件箱是会话列表 + 消息流），右下角快速记录，右侧浮出面板 */
import { QueryClientProvider } from "@tanstack/react-query";
import { useEffect } from "react";
import { Capture } from "./components/Capture";
import { Banner, QaFloat, useClaimPrompt, useGlobalInput } from "./components/Global";
import { InboxList, InboxMain } from "./components/Inbox";
import { ListPane } from "./components/ListPane";
import { Peek, Reader } from "./components/Reader";
import { Sidebar } from "./components/Sidebar";
import { Toast } from "./components/Toast";
import { DebugPanel } from "./components/Debug";
import { SettingsForm } from "./dialogs/Settings";
import { isApp } from "./lib/api";
import { qc, useAppState, useConfig, useLiveUpdates } from "./lib/data";
import { DialogHost } from "./lib/dialog";
import { applyTheme, useUi } from "./lib/store";
import { useWorkspaceSync } from "./lib/ws";

/** 桌面版第一次打开：先选这台电脑的角色 */
function FirstRun() {
  return (
    <div className="grid h-full place-items-center overflow-y-auto p-6">
      <div className="w-full max-w-[760px] rounded-[18px] bg-surface p-7 shadow-3">
        <h1 className="text-[20px] font-bold">欢迎使用工作台</h1>
        <p className="mt-1 mb-5 text-[13.5px] text-muted">先选这台电脑的角色。存数据的只需要一台（建议选一直开机、硬盘够大的那台），其他电脑选「连接到主机」。</p>
        <SettingsForm first />
      </div>
    </div>
  );
}

function Shell() {
  const theme = useUi((s) => s.theme);
  const view = useUi((s) => s.view);
  const cfg = useConfig();
  const { isLoading, data } = useAppState();
  const needSetup = isApp && cfg.isSuccess && !cfg.data.config.mode;
  useLiveUpdates(!isApp || !!cfg.data?.config.mode);
  useWorkspaceSync();
  useClaimPrompt();
  const dropping = useGlobalInput();

  useEffect(() => {
    applyTheme(theme);
    if (theme !== "system") return;
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const on = () => applyTheme("system");
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [theme]);

  if (needSetup)
    return (
      <>
        <FirstRun />
        <Toast />
      </>
    );

  return (
    <div className="flex h-full min-w-0 gap-6 p-4">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <Banner />
        <div className="flex min-h-0 min-w-0 flex-1 gap-5">
          {isLoading && !data ? (
            <div className="grid grow place-items-center text-sm text-muted">加载中…</div>
          ) : view === "inbox" ? (
            <>
              <InboxList />
              <InboxMain />
            </>
          ) : (
            <>
              <ListPane />
              <Reader />
            </>
          )}
        </div>
      </div>
      {view !== "inbox" && <Capture />}
      <Peek />
      <QaFloat />
      <DialogHost />
      <Toast />
      <DebugPanel />
      {dropping && (
        <div className="pointer-events-none fixed inset-3 z-50 grid place-items-center rounded-[22px] border-2 border-dashed border-accent bg-accent/5 text-[15px] font-semibold text-accent">
          松开：{view === "inbox" ? "放进输入框" : "放进快速记录"}（微信导出的 ZIP 会导入）
        </div>
      )}
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={qc}>
      <Shell />
    </QueryClientProvider>
  );
}
