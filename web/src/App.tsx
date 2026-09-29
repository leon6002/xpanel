/* 新界面骨架：左侧导航 · 中间列表 · 右侧阅读，右下角快速记录 */
import { QueryClientProvider } from "@tanstack/react-query";
import { useEffect } from "react";
import { Capture } from "./components/Capture";
import { ListPane } from "./components/ListPane";
import { Reader } from "./components/Reader";
import { Sidebar } from "./components/Sidebar";
import { Toast } from "./components/Toast";
import { qc, useAppState, useLiveUpdates } from "./lib/data";
import { applyTheme, useUi } from "./lib/store";

function Shell() {
  const theme = useUi((s) => s.theme);
  const { error, isLoading } = useAppState();
  useLiveUpdates();

  useEffect(() => {
    applyTheme(theme);
    if (theme !== "system") return;
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const on = () => applyTheme("system");
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [theme]);

  return (
    <div className="flex h-full min-w-0 gap-4 p-4">
      <Sidebar />
      {error ? (
        <div className="grid grow place-items-center text-muted">
          <div className="text-center">
            <p className="text-base text-fg">读不到数据</p>
            <p className="mt-1 text-sm">{error instanceof Error ? error.message : String(error)}</p>
          </div>
        </div>
      ) : isLoading ? (
        <div className="grid grow place-items-center text-sm text-muted">加载中…</div>
      ) : (
        <>
          <ListPane />
          <Reader />
        </>
      )}
      <Capture />
      <Toast />
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
