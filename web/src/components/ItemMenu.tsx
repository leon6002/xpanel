/* 右键菜单：在任何一条上点右键（首页、各个列表、收件箱的消息），直接做常用的操作——归到项目、完成、置顶、优先级、截止、转成别的类型、交给 AI、删除。
   条目的那一行带 data-item-id 就行，这里在整个页面上统一接右键。
   桌面版里别处的右键不再弹出浏览器那个菜单（输入框里、选中了文字时照旧，方便复制粘贴）。 */
import * as DM from "@radix-ui/react-dropdown-menu";
import { Box, CalendarDays, Check, ChevronRight, Copy, FileDown, Flag, Folder, PanelRightOpen, Pin, Plus, Repeat2, Sparkles, SquareCheck, Trash2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { copyText, isApp } from "../lib/api";
import { patchItem, qc, removeItem, restoreItem, useAppState } from "../lib/data";
import { addDays, allCats, noteTitle } from "../lib/logic";
import { NO_PROJECT, projectOf, projectPinned } from "../lib/projects";
import { useUi } from "../lib/store";
import type { Item, ItemType, State } from "../lib/types";
import { TYPES, isCheckable, typeName } from "../lib/types";
import { cx } from "../lib/cx";
import { openAgent } from "../dialogs/Agent";
import { exportContext } from "./Brief";
import { openProject, useProjects } from "./Projects";

const say = (t: string, action?: { label: string; run: () => void }) => useUi.getState().say(t, action);
const row = "flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] text-fg-2 outline-none data-[highlighted]:bg-surface-2 data-[highlighted]:text-fg data-[state=open]:bg-surface-2 [&_svg]:size-4 [&_svg]:shrink-0";
const panel = "scroll-quiet z-[60] max-h-[70vh] min-w-48 overflow-y-auto rounded-xl bg-surface p-1 shadow-3";

function Sub({ icon, label, value, children }: { icon: ReactNode; label: string; value?: string; children: ReactNode }) {
  return (
    <DM.Sub>
      <DM.SubTrigger className={row}>
        {icon}
        <span className="grow">{label}</span>
        {value && <span className="max-w-[110px] truncate text-xs text-faint">{value}</span>}
        <ChevronRight className="!size-3.5 text-faint" />
      </DM.SubTrigger>
      <DM.Portal>
        <DM.SubContent sideOffset={6} className={panel}>
          {children}
        </DM.SubContent>
      </DM.Portal>
    </DM.Sub>
  );
}
function Opt({ on, onSelect, children, tone }: { on?: boolean; onSelect: () => void; children: ReactNode; tone?: "muted" }) {
  return (
    <DM.Item className={cx(row, on && "font-medium text-fg", tone === "muted" && "text-muted")} onSelect={onSelect}>
      <span className="grow truncate">{children}</span>
      {on && <Check className="!size-3.5" />}
    </DM.Item>
  );
}

export function ItemMenu() {
  const [at, setAt] = useState<{ x: number; y: number; id: string } | null>(null);
  const items = useAppState().data?.items ?? [];
  const projects = useProjects();

  useEffect(() => {
    const on = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      const el = t?.closest?.("[data-item-id]") as HTMLElement | null;
      const typing = !!t?.closest?.("input, textarea, [contenteditable=true], [contenteditable='']");
      const selecting = !!window.getSelection()?.toString();
      if (el && !typing && !selecting) {
        e.preventDefault();
        setAt({ x: e.clientX, y: e.clientY, id: el.dataset.itemId! });
        return;
      }
      // 桌面版：别处不弹浏览器的菜单（刷新、另存为这些在这里没用）；要复制粘贴的地方留着
      if (isApp && !typing && !selecting && !e.shiftKey) e.preventDefault();
    };
    document.addEventListener("contextmenu", on);
    return () => document.removeEventListener("contextmenu", on);
  }, []);

  const it = at ? items.find((x) => x.id === at.id) : undefined;
  if (!at || !it) return null;
  const close = () => setAt(null);
  const cur = () => qc.getQueryData<State>(["state"])?.items.find((x) => x.id === it.id) ?? it;
  const set = (ch: Partial<Item>, done?: string) => patchItem(cur(), ch).then(() => done && say(done));
  const title = noteTitle(it) || it.title || "这一条";
  const proj = projectOf(it, projects);
  const cats = allCats(items, qc.getQueryData<State>(["state"])?.categories ?? []).slice(0, 30);
  const checkable = isCheckable(it.type);
  const due = (n: number | null, name: string) => set({ due: n == null ? undefined : addDays(n) }, n == null ? "去掉了截止日期" : `截止：${name}`);
  const nextMonday = ((8 - new Date().getDay()) % 7) || 7;
  const del = async () => {
    const copy = cur();
    await removeItem(it.id).catch(() => {});
    if (useUi.getState().peek?.id === it.id) useUi.getState().closePeek();
    say(`已删除「${title.slice(0, 20)}」`, { label: "撤销", run: () => restoreItem(copy) });
  };

  return (
    <DM.Root open onOpenChange={(o) => !o && close()} modal={false}>
      <DM.Trigger asChild>
        <span aria-hidden className="pointer-events-none fixed size-0" style={{ left: at.x, top: at.y }} />
      </DM.Trigger>
      <DM.Portal>
        <DM.Content align="start" side="bottom" sideOffset={2} className={cx(panel, "w-56")} onCloseAutoFocus={(e) => e.preventDefault()} aria-label={"对「" + title + "」的操作"}>
          <div className="truncate px-2.5 pt-1.5 pb-1 text-xs text-faint">
            {typeName(it.type)} · {title}
          </div>
          {it.type === "project" ? (
            <>
              <Opt onSelect={() => useUi.getState().setProj(it.id)}>只看这个项目</Opt>
              <Opt onSelect={() => openProject(projects.find((p) => p.id === it.id))}>编辑项目</Opt>
            </>
          ) : (
            <>
              <DM.Item className={row} onSelect={() => useUi.getState().openPeek(it.id)}>
                <PanelRightOpen />
                打开
              </DM.Item>
              {checkable && (
                <DM.Item className={row} onSelect={() => set({ done: !it.done })}>
                  <SquareCheck />
                  {it.done ? "改回没做完" : "完成"}
                </DM.Item>
              )}
              <DM.Item className={row} onSelect={() => set({ pinned: !it.pinned })}>
                <Pin />
                {it.pinned ? "取消置顶" : "置顶"}
              </DM.Item>
              <Sub icon={<Box />} label="归到项目" value={proj ? proj.name + (projectPinned(it) ? "" : "（自动）") : undefined}>
                {projects.map((p) => (
                  <Opt key={p.id} on={proj?.id === p.id} onSelect={() => set({ project: p.id }, `归到了「${p.name}」`)}>
                    {p.name}
                  </Opt>
                ))}
                <Opt tone="muted" on={it.project === NO_PROJECT} onSelect={() => set({ project: NO_PROJECT }, "不归任何项目")}>
                  不归任何项目
                </Opt>
                {(projectPinned(it) || it.project === NO_PROJECT) && (
                  <Opt tone="muted" onSelect={() => set({ project: undefined }, "改回按关键词自己认")}>
                    改回按关键词自己认
                  </Opt>
                )}
                <DM.Item className={cx(row, "text-muted")} onSelect={() => openProject(undefined, { name: "" })}>
                  <Plus />
                  新建项目…
                </DM.Item>
              </Sub>
              {checkable && (
                <>
                  <Sub icon={<Flag />} label="优先级" value={it.priority}>
                    {(["P0", "P1", "P2", "P3"] as const).map((p) => (
                      <Opt key={p} on={it.priority === p} onSelect={() => set({ priority: p })}>
                        {p}
                        <span className="ml-2 text-xs text-faint">{{ P0: "马上做", P1: "这几天", P2: "不急", P3: "有空再说" }[p]}</span>
                      </Opt>
                    ))}
                    <Opt tone="muted" on={!it.priority} onSelect={() => set({ priority: undefined })}>
                      不设
                    </Opt>
                  </Sub>
                  <Sub icon={<CalendarDays />} label="截止" value={it.due}>
                    <Opt onSelect={() => due(0, "今天")}>今天</Opt>
                    <Opt onSelect={() => due(1, "明天")}>明天</Opt>
                    <Opt onSelect={() => due(3, "三天后")}>三天后</Opt>
                    <Opt onSelect={() => due(nextMonday, "下周一")}>下周一</Opt>
                    <Opt tone="muted" on={!it.due} onSelect={() => due(null, "")}>
                      不设
                    </Opt>
                  </Sub>
                </>
              )}
              <Sub icon={<Folder />} label="分类" value={it.category?.split("/").pop()}>
                {cats.map((c) => (
                  <Opt key={c} on={it.category === c} onSelect={() => set({ category: c }, `放到了「${c}」`)}>
                    <span style={{ paddingLeft: (c.split("/").length - 1) * 12 }}>{c.split("/").pop()}</span>
                  </Opt>
                ))}
                <Opt tone="muted" on={!it.category} onSelect={() => set({ category: undefined }, "设为未分类")}>
                  未分类
                </Opt>
              </Sub>
              <Sub icon={<Repeat2 />} label="转成" value={typeName(it.type)}>
                {TYPES.map((t) => (
                  <Opt key={t.k} on={it.type === t.k} onSelect={() => set({ type: t.k as ItemType }, `转成了${t.name}`)}>
                    {t.name}
                  </Opt>
                ))}
              </Sub>
              <DM.Separator className="my-1 h-px bg-surface-2" />
              <DM.Item className={row} onSelect={() => openAgent(cur())}>
                <Sparkles />
                交给 AI
              </DM.Item>
              <DM.Item className={row} onSelect={() => exportContext(it.id)}>
                <FileDown />
                导出上下文
              </DM.Item>
              <DM.Item className={row} onSelect={async () => say((await copyText([it.title, it.body].filter(Boolean).join("\n\n"))) ? "已复制标题和正文" : "复制失败")}>
                <Copy />
                复制内容
              </DM.Item>
              <DM.Separator className="my-1 h-px bg-surface-2" />
              <DM.Item className={cx(row, "text-danger data-[highlighted]:text-danger")} onSelect={del}>
                <Trash2 />
                删除
              </DM.Item>
            </>
          )}
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}
