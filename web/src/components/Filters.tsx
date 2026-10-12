/* 列表上方的「筛选」：分类、标签、设备。原来常驻在左侧，现在点开才出来；选了的显示成一个个小标签，点 × 去掉。
   分类旁边的数字是当前页面里这个分类有几条。 */
import * as DM from "@radix-ui/react-dropdown-menu";
import { ChevronRight, ListFilter, Search, Settings2, X } from "lucide-react";
import { Fragment, useMemo } from "react";
import { useAppState, useDevices } from "../lib/data";
import { allCats, allTags, devOnline, inCat, parentCat, viewOf } from "../lib/logic";
import { useUi } from "../lib/store";
import { cx } from "../lib/cx";
import { openCatMgr } from "../dialogs/Categories";
import { NO_PROJECT } from "../lib/projects";
import { openProject, useProjects } from "./Projects";

const row = "flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] outline-none data-[highlighted]:bg-surface-2";
const head = "px-2.5 pt-2 pb-1 text-xs text-muted";

/** bar：页面上已经有常驻的分类和标签（CatBar），这里就不再重复显示选中的分类和标签 */
export function Filters({ bar }: { bar?: boolean } = {}) {
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
  const projects = useProjects();
  const active = [
    ui.proj && { key: "proj", text: ui.proj === NO_PROJECT ? "没归项目的" : (projects.find((p) => p.id === ui.proj)?.name ?? "项目"), clear: () => ui.setProj(null) },
    !bar && ui.cat && { key: "cat", text: ui.cat === "none" ? "未分类" : ui.cat.split("/").pop()!, clear: () => ui.setCat(null) },
    !bar && ui.tag && { key: "tag", text: "#" + ui.tag, clear: () => ui.setTag(null) },
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
            {projects.length > 0 && (
              <>
                <div className={head}>项目</div>
                {projects
                  .filter((p) => p.status !== "done" || p.id === ui.proj)
                  .map((p) => (
                    <DM.Item key={p.id} className={cx(row, ui.proj === p.id ? "bg-surface-3 font-medium text-fg" : "text-fg-2")} onSelect={() => ui.setProj(ui.proj === p.id ? null : p.id)}>
                      <span className="grow truncate">{p.name}</span>
                    </DM.Item>
                  ))}
                <DM.Item className={cx(row, ui.proj === NO_PROJECT ? "bg-surface-3 font-medium text-fg" : "text-muted")} onSelect={() => ui.setProj(ui.proj === NO_PROJECT ? null : NO_PROJECT)}>
                  没归项目的
                </DM.Item>
              </>
            )}
            {!projects.length && (
              <DM.Item className={cx(row, "text-muted")} onSelect={() => openProject()}>
                建一个项目…
              </DM.Item>
            )}
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

/** 页面上方的搜索框：只在这一页里找（标题、正文、标签、分类），Esc 清空 */
export function SearchBox({ className }: { className?: string }) {
  const q = useUi((s) => s.q);
  const setQ = useUi((s) => s.setQ);
  return (
    <label className={cx("flex h-[34px] w-56 items-center gap-2 rounded-[10px] bg-surface px-3 text-[13px] text-fg focus-within:bg-surface-2", className)}>
      <Search className="size-3.5 shrink-0 text-faint" />
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.stopPropagation();
          if (q) setQ("");
          else e.currentTarget.blur();
        }}
        placeholder="在这一页里搜"
        aria-label="在这一页里搜"
        className="min-w-0 grow bg-transparent outline-none placeholder:text-faint [&::-webkit-search-cancel-button]:hidden"
      />
      {q && (
        <button type="button" aria-label="清空搜索" onClick={() => setQ("")} className="grid size-5 place-items-center rounded text-faint hover:text-fg">
          <X className="size-3.5" />
        </button>
      )}
    </label>
  );
}

/** 常驻在页面上方的分类和标签：一行分类（选了有子分类的再列出子分类），后面是这一页里常用的标签。
    点一下筛选，再点一下取消；分类和标签可以一起用。项目、设备这些不常用的还在「筛选」里 */
export function CatBar() {
  const { data } = useAppState();
  const items = data?.items ?? [];
  const ui = useUi();
  const here = useMemo(() => items.filter((i) => i.type !== "project" && viewOf(i) === ui.view && !(ui.view === "work" && i.done)), [items, ui.view]);
  const cats = useMemo(() => allCats(here), [here]);
  const n = (p: string) => here.filter((i) => inCat(i.category, p)).length;
  const none = here.filter((i) => !i.category).length;
  const setCat = (c: string | null) => useUi.setState({ cat: c });
  const sel = ui.cat && ui.cat !== "none" ? ui.cat : null;
  const kids = (p: string) => cats.filter((c) => parentCat(c) === p);
  // 选的分类有子分类就列它的子分类；选的是最底下一层就列它和同级的
  const base = sel ? (kids(sel).length ? sel : parentCat(sel)) : "";
  const tags = useMemo(() => allTags(here.filter((i) => !sel || inCat(i.category, sel))).slice(0, 12), [here, sel]);
  if (!cats.length && !tags.length) return null;
  const chip = (on: boolean) => cx("flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] whitespace-nowrap", on ? "bg-ink text-on-ink" : "bg-surface text-fg-2 hover:bg-surface-2 hover:text-fg");
  const count = (k: number, on: boolean) => <span className={cx("text-[11.5px]", on ? "opacity-70" : "text-faint")}>{k}</span>;
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-1" aria-label="分类和标签">
      {cats.length > 0 && (
        <>
          <button className={chip(!ui.cat)} onClick={() => setCat(null)}>
            全部 {count(here.length, !ui.cat)}
          </button>
          {kids("").map((c) => {
            const on = !!sel && inCat(sel, c);
            return (
              <Fragment key={c}>
                <button className={chip(on)} onClick={() => setCat(sel === c ? null : c)} title={on && sel !== c ? "回到「" + c + "」" : undefined}>
                  {c} {count(n(c), on)}
                </button>
              {on && base && (
                <>
                  <ChevronRight className="size-3.5 shrink-0 text-faint" />
                  {kids(base).map((k) => {
                    const on2 = !!sel && inCat(sel, k);
                    return (
                      <button key={k} className={chip(on2)} onClick={() => setCat(sel === k ? base : k)}>
                        {k.slice(base.length + 1)} {count(n(k), on2)}
                      </button>
                    );
                  })}
                </>
              )}
              </Fragment>
            );
          })}
          {none > 0 && (
            <button className={chip(ui.cat === "none")} onClick={() => setCat(ui.cat === "none" ? null : "none")}>
              未分类 {count(none, ui.cat === "none")}
            </button>
          )}
        </>
      )}
      {tags.length > 0 && <span className="w-2" />}
      {tags.map(([t, k]) => (
        <button key={t} className={cx(chip(ui.tag === t), "rounded-full")} onClick={() => ui.setTag(ui.tag === t ? null : t)} title={`${k} 条`}>
          #{t}
        </button>
      ))}
    </div>
  );
}
