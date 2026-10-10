/* 首页：打开先看到的一整页。不用先选「事项」还是「笔记」，各种内容按要紧程度自动排好，能直接处理：
   勾完成、把收件箱里的消息转成事项或笔记、点开任何一条在右侧面板里看和改、点入口直接打开。
   完整的列表（批量整理、按分类筛选）还在各自的页面。 */
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Bot, Check, FileText, Inbox as InboxIcon, KeyRound, Link2, MessageSquare, Pin, Plus, Search, SquareCheck } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { copyText, openTarget } from "../lib/api";
import { briefOf, openQuestions } from "../lib/brief";
import { patchItem, useAppState, useChats } from "../lib/data";
import { ago, byPriority, byRecent, dueInfo, entryTarget, noteTitle, plain, viewOf } from "../lib/logic";
import { ls, useUi, type View } from "../lib/store";
import type { Item } from "../lib/types";
import { typeName } from "../lib/types";
import { VAULT_KEY, fetchVault, identityOf, mainOf, openSecret, useVault, useVaultUi } from "../lib/vault";
import { bumpUsage, titleOf, type Entry } from "../lib/vaultSearch";
import { cx } from "../lib/cx";
import { NO_PROJECT, projectOf, secretProject } from "../lib/projects";
import { openPalette } from "./Palette";
import { ProjectBar, useProjects } from "./Projects";
import { EntryIcon } from "./Vault";
import { Chip, Pri } from "./ui";

function greet() {
  const d = new Date();
  const h = d.getHours();
  return `${d.getMonth() + 1}月${d.getDate()}日 · 星期${"日一二三四五六"[d.getDay()]} · ${h < 6 ? "夜深了" : h < 11 ? "早上好" : h < 14 ? "中午好" : h < 18 ? "下午好" : "晚上好"}`;
}

/* ---- 入口点过几次（只记在这台电脑的浏览器里），常点的排前面 ---- */
const LINK_KEY = "wb-link-usage";
function linkUsage(): Record<string, number> {
  try {
    return JSON.parse(ls.get(LINK_KEY) || "{}");
  } catch {
    return {};
  }
}
export function bumpLink(id: string) {
  const u = linkUsage();
  u[id] = (u[id] ?? 0) + 1;
  ls.set(LINK_KEY, JSON.stringify(u));
}

/** 事项有多要紧：逾期 → 今明两天到期 → 置顶 → P0 → P1 → 其他 */
const urgency = (it: Item) => {
  const d = dueInfo(it);
  return d?.tone === "late" ? 0 : d?.tone === "soon" ? 1 : it.pinned ? 2 : it.priority === "P0" ? 3 : it.priority === "P1" ? 4 : 9;
};

function Card({ title, hint, action, children, className }: { title: string; hint?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section aria-label={title} className={cx("flex min-w-0 flex-col gap-1 rounded-[18px] bg-surface p-3", className)}>
      <h2 className="flex items-center gap-2 px-2 pt-0.5 pb-1 text-[13px] font-semibold text-fg">
        {title}
        {hint && <span className="text-xs font-normal text-muted">{hint}</span>}
        <span className="grow" />
        {action}
      </h2>
      {children}
    </section>
  );
}
const more = "flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-muted hover:bg-surface-2 hover:text-fg [&_svg]:size-3.5";
const rowCls = "group flex min-h-[36px] items-center gap-2.5 rounded-xl px-2 hover:bg-surface-2";
const Empty = ({ children }: { children: ReactNode }) => <p className="px-2 py-3 text-[13px] text-faint">{children}</p>;

function TaskLine({ it, tag }: { it: Item; tag?: string }) {
  const open = useUi((s) => s.openPeek);
  const di = dueInfo(it);
  return (
    <div className={rowCls} data-item-id={it.id}>
      <button
        role="checkbox"
        aria-checked={!!it.done}
        aria-label={"完成：" + it.title}
        title="勾掉"
        onClick={() => patchItem(it, { done: !it.done })}
        className="grid size-[18px] shrink-0 place-items-center rounded-[5px] border-[1.5px] border-faint text-transparent transition-colors hover:border-fg hover:text-faint [&_svg]:size-3"
      >
        <Check strokeWidth={3} />
      </button>
      <button onClick={() => open(it.id)} className="flex min-w-0 grow items-center gap-1.5 py-1.5 text-left text-sm" title="点开看和改">
        {it.pinned && <Pin className="size-3.5 shrink-0 text-accent" />}
        <Pri p={it.priority} />
        <span className="truncate text-fg">{it.title}</span>
        {it.type !== "todo" && <span className="shrink-0 text-xs text-faint">{typeName(it.type)}</span>}
      </button>
      {(tag || it.category) && <span className="hidden max-w-[120px] shrink-0 truncate text-xs text-faint sm:inline">{tag || it.category!.split("/").pop()}</span>}
      {di && <Chip tone={di.tone === "late" ? "danger" : di.tone === "soon" ? "warn" : "plain"}>{di.text}</Chip>}
      <button
        aria-label={it.pinned ? "取消置顶" : "置顶"}
        title={it.pinned ? "取消置顶" : "置顶（排到前面）"}
        onClick={() => patchItem(it, { pinned: !it.pinned })}
        className={cx("grid size-7 shrink-0 place-items-center rounded-md opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-surface-3 [&_svg]:size-3.5", it.pinned ? "text-accent" : "text-faint hover:text-fg")}
      >
        <Pin />
      </button>
    </div>
  );
}

export function Home() {
  const everything = useAppState().data?.items ?? [];
  const chats = useChats().data ?? [];
  const ui = useUi();
  const [all, setAll] = useState(false);
  const projects = useProjects();
  // 每一条属于哪个项目（写了的以写的为准，没写的按关键词认）
  const owner = useMemo(() => new Map(everything.map((i) => [i.id, projectOf(i, projects)?.id])), [everything, projects]);
  // 只看某个项目时，整页都只剩它的
  const items = useMemo(
    () => everything.filter((i) => i.type !== "project" && (!ui.proj || (ui.proj === NO_PROJECT ? !owner.get(i.id) : owner.get(i.id) === ui.proj))),
    [everything, owner, ui.proj],
  );
  // 项目旁边的数字：还有几条没做完的事项
  const [openCount, loose] = useMemo(() => {
    const c = new Map<string, number>();
    let none = 0;
    for (const i of everything) {
      if (viewOf(i) !== "work" || i.done) continue;
      const p = owner.get(i.id);
      if (p) c.set(p, (c.get(p) ?? 0) + 1);
      else none++;
    }
    return [c, none];
  }, [everything, owner]);
  const vault = useQuery({ queryKey: VAULT_KEY, queryFn: fetchVault }).data;
  const vks = useVault((s) => s.vks);
  const rawCount = (vault?.secrets ?? []).filter((x) => x.kind === "raw").length;

  const work = useMemo(() => items.filter((i) => viewOf(i) === "work" && !i.done).sort((a, b) => urgency(a) - urgency(b) || byPriority(a, b)), [items]);
  const urgent = work.filter((i) => urgency(i) < 9);
  const calm = work.filter((i) => urgency(i) === 9);
  // 没有要紧的就先露几条普通的，不留一块空白
  // 看全部、而且建了项目：要紧的排最前，其余的按项目分组，一组先露几条
  const grouped = !ui.proj && projects.length > 0;
  const top = grouped ? urgent : urgent.length ? urgent : calm.slice(0, 5);
  const rest = grouped ? [] : urgent.length ? calm : calm.slice(5);
  const groups = useMemo(() => {
    if (!grouped) return [];
    const by = new Map<string, Item[]>();
    for (const i of calm) by.set(owner.get(i.id) ?? NO_PROJECT, [...(by.get(owner.get(i.id) ?? NO_PROJECT) ?? []), i]);
    return [...projects.filter((p) => by.has(p.id)).map((p) => ({ id: p.id, name: p.name, list: by.get(p.id)! })), ...(by.has(NO_PROJECT) ? [{ id: NO_PROJECT, name: "没归项目的", list: by.get(NO_PROJECT)! }] : [])];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grouped, work, owner, projects]);

  const inbox = useMemo(() => items.filter((i) => i.type === "inbox").sort(byRecent), [items]);
  const unread = chats.reduce((n, c) => n + (c.unread || 0), 0);
  // AI 回写了进展、等你看的：卡住的排前面，只看最近一周
  const ai = useMemo(() => {
    const week = Date.now() - 7 * 864e5;
    return items
      .map((it) => ({ it, p: (it.agentProgress || []).slice(-1)[0] }))
      .filter((x) => x.p && x.p.at > week && x.p.status !== "working" && !x.it.done)
      .sort((a, b) => Number(b.p!.status === "blocked") - Number(a.p!.status === "blocked") || b.p!.at - a.p!.at)
      .slice(0, 5);
  }, [items]);
  // 和 AI 讨论到一半的：它在等你回答，或者出了计划等你点开始
  const briefs = useMemo(
    () =>
      items
        .map((it) => ({ it, b: briefOf(it) }))
        .filter((x) => x.b && (x.b.status === "ready" || (x.b.status === "asking" && x.b.rounds.length > 0)))
        .sort((a, b) => b.it.updatedAt - a.it.updatedAt)
        .slice(0, 6),
    [items],
  );
  const notes = useMemo(
    () =>
      items
        .filter((i) => i.type === "note" || i.type === "rule")
        .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || byRecent(a, b))
        .slice(0, 8),
    [items],
  );
  const links = useMemo(() => {
    const u = linkUsage();
    return items
      .filter((i) => i.type === "link")
      .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || (u[b.id] ?? 0) - (u[a.id] ?? 0) || byRecent(a, b))
      .slice(0, 16);
  }, [items]);

  // 只看一个项目时：这个项目的账号（密码库解锁着才看得到）
  const inProject = !!ui.proj && ui.proj !== NO_PROJECT;
  const accounts = useMemo<Entry[]>(
    () => (inProject && vault && vks ? vault.secrets.map((s) => ({ s, f: openSecret(s, vks) })).filter((e) => e.f && secretProject(e.f, projects)?.id === ui.proj) : []),
    [inProject, vault, vks, projects, ui.proj],
  );
  const copyAccount = async (e: Entry) => {
    const hit = mainOf(e.f!);
    if (!hit?.value) return ui.say(`「${titleOf(e)}」没有填密码`);
    if (!(await copyText(hit.value))) return ui.say("复制失败");
    bumpUsage(e.s.id);
    useVault.getState().touch();
    ui.say(`已复制「${titleOf(e)}」的${hit.spec.label.replace(/（.*）$/, "")}`);
  };
  const go = (v: View) => {
    // 换到别的页面时项目的范围留着：在看某个项目就接着只看它的
    useUi.setState({ cat: null, tag: null, q: "", dev: null });
    ui.setView(v);
  };
  const waiting = inbox.length + unread + rawCount + ai.length + briefs.length;

  return (
    <main aria-label="首页" className="scroll-quiet flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto pb-20">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-1">
        <div className="flex flex-col">
          <h1 className="text-[19px] font-bold">xpanel</h1>
          <span className="text-xs text-muted">{greet()}</span>
        </div>
        <button onClick={openPalette} className="flex h-11 min-w-[240px] grow basis-[360px] items-center gap-2.5 rounded-xl bg-surface px-4 text-left text-[14px] text-faint hover:bg-surface-2 max-w-[720px]" aria-label="搜索全部内容">
          <Search className="size-[18px] text-muted" />
          <span className="grow truncate">搜全部：事项、笔记、消息、入口、密码库…</span>
          <kbd className="rounded-md bg-surface-3 px-1.5 font-mono text-[11px] text-muted">Ctrl K</kbd>
        </button>
      </div>
      <ProjectBar counts={openCount} loose={loose} />
      <div className="grid items-start gap-3 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-3">
          <Card
            title="现在该做的"
            hint={work.length ? `${grouped ? "要紧的在最前，其余按项目分" : "逾期、快到期、置顶、P0 / P1 排在前面"} · 共 ${work.length} 条没做完` : undefined}
            action={
              <>
                <button className={more} onClick={() => ui.focusCapture("todo")} title="记一条事项">
                  <Plus /> 记一条
                </button>
                <button className={more} onClick={() => go("work")}>
                  全部事项 <ArrowRight />
                </button>
              </>
            }
          >
            {top.map((it) => (
              <TaskLine key={it.id} it={it} tag={grouped ? projects.find((p) => p.id === owner.get(it.id))?.name : undefined} />
            ))}
            {groups.map((g) => (
              <div key={g.id} className="flex flex-col">
                <button className="flex items-center gap-2 px-2 pt-2 pb-0.5 text-left text-xs font-semibold text-muted hover:text-fg" onClick={() => ui.setProj(g.id)} title="只看这个项目">
                  {g.name}
                  <span className="font-normal text-faint">{g.list.length}</span>
                </button>
                {(all ? g.list : g.list.slice(0, 4)).map((it) => (
                  <TaskLine key={it.id} it={it} />
                ))}
                {!all && g.list.length > 4 && (
                  <button className={cx(more, "self-start")} onClick={() => ui.setProj(g.id)}>
                    还有 {g.list.length - 4} 条
                  </button>
                )}
              </div>
            ))}
            {!work.length && <Empty>没有没做完的事项。右下角的加号，或者按 / 记一条。</Empty>}
            {rest.length > 0 && (
              <>
                {all && rest.slice(0, 40).map((it) => <TaskLine key={it.id} it={it} />)}
                <button className={cx(more, "self-start")} onClick={() => setAll(!all)}>
                  {all ? "收起不急的" : `还有 ${rest.length} 条不急的`}
                </button>
              </>
            )}
          </Card>
          <Card
            title="等你处理"
            hint={waiting ? undefined : "都处理完了"}
            action={
              <>
                {unread > 0 && (
                  <button className={more} onClick={() => go("inbox")}>
                    <MessageSquare /> 聊天未读 {unread}
                  </button>
                )}
                {rawCount > 0 && (
                  <button className={more} onClick={() => go("vault")}>
                    <KeyRound /> 密码待整理 {rawCount}
                  </button>
                )}
                <button className={more} onClick={() => go("inbox")}>
                  收件箱 {inbox.length || ""} <ArrowRight />
                </button>
              </>
            }
          >
            {briefs.map(({ it, b }) => (
              <button key={"brief" + it.id} data-item-id={it.id} onClick={() => ui.openPeek(it.id)} className={cx(rowCls, "text-left")}>
                <Bot className="size-[17px] shrink-0 text-accent" strokeWidth={1.8} />
                <Chip tone="accent">{b!.status === "ready" ? "出了计划，等你确认" : `等你回答 ${openQuestions(b).length} 个问题`}</Chip>
                <span className="min-w-0 grow truncate text-sm font-medium text-fg">{noteTitle(it)}</span>
                <span className="shrink-0 text-xs text-faint">{b!.agent}</span>
              </button>
            ))}
            {ai.map(({ it, p }) => (
              <button key={"ai" + it.id} data-item-id={it.id} onClick={() => ui.openPeek(it.id)} className={cx(rowCls, "text-left")}>
                <Bot className="size-[17px] shrink-0 text-muted" strokeWidth={1.8} />
                <Chip tone={p!.status === "blocked" ? "danger" : "accent"}>AI {p!.status === "blocked" ? "卡住了" : "做完了"}</Chip>
                <span className="min-w-0 shrink-0 truncate text-sm font-medium text-fg">{noteTitle(it)}</span>
                <span className="min-w-0 grow truncate text-xs text-muted">{plain(p!.text)}</span>
                <span className="shrink-0 text-xs text-faint">{ago(p!.at)}</span>
              </button>
            ))}
            {inbox.slice(0, 6).map((it) => (
              <div key={it.id} className={rowCls} data-item-id={it.id}>
                <InboxIcon className="size-[17px] shrink-0 text-muted" strokeWidth={1.8} />
                <button onClick={() => ui.openPeek(it.id)} className="min-w-0 grow truncate py-1.5 text-left text-sm text-fg" title="点开看">
                  {plain(it.body || it.title)}
                </button>
                <span className="shrink-0 text-xs text-faint group-hover:hidden">{ago(it.createdAt)}</span>
                <span className="hidden shrink-0 items-center gap-1 group-hover:flex">
                  <button className="flex h-7 items-center gap-1 rounded-md bg-surface px-2 text-xs text-fg-2 hover:bg-surface-3 hover:text-fg [&_svg]:size-3.5" onClick={() => patchItem(it, { type: "todo" }).then(() => ui.say("转成了事项"))}>
                    <SquareCheck /> 事项
                  </button>
                  <button className="flex h-7 items-center gap-1 rounded-md bg-surface px-2 text-xs text-fg-2 hover:bg-surface-3 hover:text-fg [&_svg]:size-3.5" onClick={() => patchItem(it, { type: "note" }).then(() => ui.say("转成了笔记"))}>
                    <FileText /> 笔记
                  </button>
                </span>
              </div>
            ))}
            {inbox.length > 6 && (
              <button className={cx(more, "self-start")} onClick={() => go("inbox")}>
                收件箱里还有 {inbox.length - 6} 条
              </button>
            )}
            {!ai.length && !inbox.length && !briefs.length && <Empty>收件箱是空的，也没有 AI 等你回话。</Empty>}
          </Card>
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          <Card
            title="接着写"
            hint="置顶的和最近改过的笔记"
            action={
              <button className={more} onClick={() => go("notes")}>
                全部笔记 <ArrowRight />
              </button>
            }
          >
            {notes.map((it) => (
              <button key={it.id} data-item-id={it.id} onClick={() => ui.openPeek(it.id)} className={cx(rowCls, "text-left")} title="点开看和改">
                <FileText className="size-[17px] shrink-0 text-muted" strokeWidth={1.8} />
                {it.pinned && <Pin className="size-3.5 shrink-0 text-accent" />}
                <span className="min-w-0 grow truncate text-sm text-fg">{noteTitle(it)}</span>
                {it.category && <span className="max-w-[110px] shrink-0 truncate text-xs text-faint">{it.category.split("/").pop()}</span>}
                <span className="shrink-0 text-xs text-faint">{ago(it.updatedAt)}</span>
              </button>
            ))}
            {!notes.length && <Empty>还没有笔记。</Empty>}
          </Card>
          {inProject && !!vault?.keys.length && (
            <Card
              title="这个项目的账号"
              hint={vks ? (accounts.length ? "点一下复制密码" : undefined) : undefined}
              action={
                <button className={more} onClick={() => go("vault")}>
                  密码库 <ArrowRight />
                </button>
              }
            >
              {!vks ? (
                <Empty>密码库锁着。解锁后这里列出归到这个项目的账号。</Empty>
              ) : accounts.length ? (
                accounts.map((e) => (
                  <div key={e.s.id} className={rowCls}>
                    <EntryIcon e={e} />
                    <button className="flex min-w-0 grow items-baseline gap-2 py-1.5 text-left" onClick={() => copyAccount(e)} title="点一下复制密码">
                      <span className="truncate text-sm text-fg">{titleOf(e)}</span>
                      <span className="truncate font-mono text-xs text-muted">{identityOf(e.f!)?.value}</span>
                    </button>
                    <button
                      className="hidden h-7 shrink-0 items-center rounded-md bg-surface px-2 text-xs text-fg-2 group-hover:flex hover:bg-surface-3 hover:text-fg"
                      onClick={() => {
                        useVaultUi.getState().setSel(e.s.id);
                        go("vault");
                      }}
                    >
                      看全部
                    </button>
                  </div>
                ))
              ) : (
                <Empty>还没有归到这个项目的账号。在密码库里编辑一条，选上这个项目；名称里带项目关键词的会自动归过来。</Empty>
              )}
            </Card>
          )}
          <Card
            title="常用入口"
            hint="置顶的和常点的在前面"
            action={
              <button className={more} onClick={() => go("links")}>
                全部入口 <ArrowRight />
              </button>
            }
          >
            <div className="flex flex-wrap gap-1.5 px-1.5 pb-1">
              {links.map((it) => {
                const t = entryTarget(it);
                return (
                  <button
                    key={it.id}
                    data-item-id={it.id}
                    title={t || "还没填网址或路径"}
                    onClick={async () => {
                      if (!t) return ui.openPeek(it.id);
                      bumpLink(it.id);
                      const how = await openTarget(t);
                      ui.say(how === "copied" ? "已复制：" + t : "已打开：" + it.title);
                    }}
                    className="flex h-8 max-w-[220px] items-center gap-1.5 rounded-lg bg-surface-2 px-2.5 text-[13px] text-fg-2 hover:bg-surface-3 hover:text-fg"
                  >
                    {it.pinned ? <Pin className="size-3.5 shrink-0 text-accent" /> : <Link2 className="size-3.5 shrink-0 text-muted" />}
                    <span className="truncate">{it.title}</span>
                  </button>
                );
              })}
            </div>
            {!links.length && <Empty>还没有入口。常用的网址、文件夹、远程地址可以记成入口。</Empty>}
          </Card>
        </div>
      </div>
    </main>
  );
}
