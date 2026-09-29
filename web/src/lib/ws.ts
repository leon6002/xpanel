/* 笔记展开成项目（给 AI 当工作目录）。
   交给 AI 时可以把条目展开成项目文件夹：.xpanel/ 里放任务说明、笔记原文、编号截图，AI 在项目里干活。
   笔记之后再贴内容，这台电脑上的 xpanel 会自动同步进去；「继续」时只告诉 AI 新增了什么。 */
import { useEffect, useRef } from "react";
import { desk, isApp, v1 } from "./api";
import { patchItem, qc, useAppState, useThisDevice } from "./data";
import { useUi } from "./store";
import type { Device, Item, State, Workspace } from "./types";

export function myWorkspace(it: Item, me: { id: string; hostname: string }): Workspace | null {
  const hn = me.hostname.toLowerCase();
  return (it.workspaces || []).find((w) => (me.id && w.deviceId === me.id) || (!w.deviceId && hn && String(w.hostname || "").toLowerCase() === hn)) || null;
}

export function useMyWorkspace(it: Item | undefined) {
  const me = useThisDevice();
  return it && isApp ? myWorkspace(it, me) : null;
}

/** 记下项目：条目上的 workspaces，和这台设备的「项目」列表 */
export async function recordWorkspace(it: Item, me: { id: string; hostname: string }, path: string, name: string, template: string, agent: string) {
  const cur = qc.getQueryData<State>(["state"])?.items.find((x) => x.id === it.id) ?? it;
  const w: Workspace = { deviceId: me.id, hostname: me.hostname, path, name, template, createdAt: Date.now() };
  const list = (cur.workspaces || []).filter((x) => x.path !== path && !(w.deviceId && x.deviceId === w.deviceId));
  await patchItem(cur, { workspaces: [...list, w] }).catch(() => {});
  const d = qc.getQueryData<State>(["state"])?.devices?.find((x: Device) => x.id === me.id);
  if (d && !(d.projects || []).some((p) => String(p.path).toLowerCase() === path.toLowerCase())) {
    await v1("PATCH", "/devices/" + encodeURIComponent(d.id), {
      projects: [...(d.projects || []), { name, path, agent, note: "由笔记「" + (cur.title || "") + "」生成" }],
    }).catch(() => {});
  }
}

/** 笔记改了就同步到这台电脑上的项目（没变化时桌面版直接跳过） */
export function useWorkspaceSync() {
  const { data } = useAppState();
  const me = useThisDevice();
  const busy = useRef(false);
  useEffect(() => {
    if (!isApp || !data) return;
    const t = window.setTimeout(async () => {
      if (busy.current) return;
      busy.current = true;
      try {
        for (const it of data.items) {
          const w = myWorkspace(it, me);
          if (!w) continue;
          try {
            const r = await desk.wsSync(it, w.path, false);
            if (r && !r.skipped && !r.empty) useUi.getState().say(`已同步到项目「${w.name}」：${r.summary}`);
          } catch {
            /* 文件夹可能被移走了 */
          }
        }
      } finally {
        busy.current = false;
      }
    }, 1200);
    return () => window.clearTimeout(t);
  }, [data, me.id, me.hostname]);
}
