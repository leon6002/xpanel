/* 列表上方的「筛选」：分类、标签、设备。原来常驻在左侧，现在点开才出来；选了的显示成一个个小标签，点 × 去掉。
   分类旁边的数字是当前页面里这个分类有几条。 */
import * as DM from "@radix-ui/react-dropdown-menu";
import { ListFilter, Settings2, X } from "lucide-react";
import { useMemo } from "react";
import { useAppState, useDevices } from "../lib/data";
import { allCats, allTags, devOnline, inCat, parentCat, viewOf } from "../lib/logic";
import { useUi } from "../lib/store";
import { cx } from "../lib/cx";
import { openCatMgr } from "../dialogs/Categories";

const row = "flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] outline-none data-[highlighted]:bg-surface-2";
const head = "px-2.5 pt-2 pb-1 text-xs text-muted";

export function Filters() {
  const { data } = useAppState();
  const items = data?.items ?? [];
  const devices = useDevices();
  const ui = useUi();
  const cats = useMemo(() => allCats(items, data?.categories ?? []), [items, data?.categories]);
  const tags = useMemo(() => allTags(items).slice(0, 30), [items]);
  const here = (i: (typeof items)[number]) => viewOf(i) === ui.view && !(ui.view === "work" && i.done);
  const n = (p: string) => items.filter((i) => inCat(i.category, p) && here(i)).length;
  const depth = (p: string) => p.split("/").length - 1;
  // 按树的顺序排开：父分类后面紧跟它的子分类
  const ordered = useMemo(() => {
    const out: string[] = [];
    const walk = (p: string) => cats.filter((c) => parentCat(c) === p).forEach((c) => (out.push(c), walk(c)));
    walk("");
    return out;
  }, [cats]);
  const active = [
    ui.cat && { key: "cat", text: ui.cat === "none" ? "未分类" : ui.cat.split("/").pop()!, clear: () => ui.setCat(null) },
    ui.tag && { key: "tag", text: "#" + ui.tag, clear: () => ui.setTag(null) },
    ui.dev && { key: "dev", text: ui.dev, clear: () => ui.setDev(null) },
  ].filter(Boolean) as { key: string; text: string; clear: () => void }[];

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5 px-1">
      <DM.Root>
        <DM.Trigger asChild>
          <button className="flex h-7 items-center gap-1.5 rounded-lg bg-surface-2 px-2.5 text-[12.5px] text-fg-2 hover:bg-surface-3 hover:text-fg" title="按分类、标签、设备筛选">
            <ListFilter className="size-3.5" />
            筛选
          </button>
        </DM.Trigger>
        <DM.Portal>
          <DM.Content align="start" sideOffset={6} className="scroll-quiet z-50 max-h-[70vh] w-64 overflow-y-auto rounded-xl bg-surface p-1 shadow-3">
            <div className={head}>分类</div>
            <DM.Item className={cx(row, !ui.cat && "font-medium text-fg")} onSelect={() => ui.setCat(null)}>
              全部
            </DM.Item>
            {ordered.map((p) => (
              <DM.Item key={p} className={cx(row, ui.cat === p ? "bg-surface-3 font-medium text-fg" : "text-fg-2")} style={{ paddingLeft: 10 + depth(p) * 14 }} onSelect={() => ui.setCat(ui.cat === p ? null : p)}>
                <span className="grow truncate">{p.split("/").pop()}</span>
                <span className="text-xs text-muted">{n(p) || ""}</span>
              </DM.Item>
            ))}
            <DM.Item className={cx(row, ui.cat === "none" ? "bg-surface-3 font-medium text-fg" : "text-muted")} onSelect={() => ui.setCat(ui.cat === "none" ? null : "none")}>
              未分类
            </DM.Item>
            {tags.length > 0 && (
              <>
                <div className={head}>标签</div>
                <div className="flex flex-wrap gap-1.5 px-2.5 pb-1.5">
                  {tags.map(([t, c]) => (
                    <DM.Item key={t} title={`${c} 条`} onSelect={() => ui.setTag(ui.tag === t ? null : t)} className={cx("cursor-pointer rounded-full px-2.5 py-0.5 text-xs outline-none", ui.tag === t ? "bg-ink text-on-ink" : "bg-surface-2 text-fg-2 data-[highlighted]:bg-surface-3")}>
                      #{t}
                    </DM.Item>
                  ))}
                </div>
              </>
            )}
            {devices.length > 0 && (
              <>
                <div className={head}>只看和这台设备有关的</div>
                {devices.map((d) => (
                  <DM.Item key={d.id} className={cx(row, ui.dev === d.name ? "bg-surface-3 font-medium text-fg" : "text-fg-2")} onSelect={() => ui.setDev(ui.dev === d.name ? null : d.name)}>
                    <span className={cx("size-1.5 shrink-0 rounded-full", devOnline(d) ? "bg-ok" : "bg-line")} />
                    <span className="truncate">{d.name}</span>
                  </DM.Item>
                ))}
              </>
            )}
            <DM.Item className={cx(row, "mt-1 text-muted")} onSelect={() => openCatMgr()}>
              <Settings2 className="size-3.5" />
              管理分类和标签
            </DM.Item>
          </DM.Content>
        </DM.Portal>
      </DM.Root>
      {active.map((a) => (
        <button key={a.key} onClick={a.clear} title="去掉这个筛选" className="flex h-7 max-w-[150px] items-center gap-1 rounded-lg bg-surface-3 pr-1.5 pl-2.5 text-[12.5px] font-medium text-fg hover:bg-surface-2">
          <span className="truncate">{a.text}</span>
          <X className="size-3.5 shrink-0 text-muted" />
        </button>
      ))}
    </div>
  );
}
