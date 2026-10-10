/* 全局搜索：在任何页面按 Ctrl+K（Mac 上 ⌘K），一个框搜全部——事项、笔记、收件箱、微信聊天记录、入口、规范，密码库解锁着的话也一起搜。
   条目和密码库在本机搜（lib/search.ts、lib/vaultSearch.ts，容错、按相关程度排）；聊天记录太多，交给主机的全文索引。
   回车打开那一条（入口是直接打开网址，密码库是复制密码），Ctrl+回车在右侧面板里看、不离开当前页面。 */
import { useQuery } from "@tanstack/react-query";
import { BookMarked, CircleAlert, FileText, Inbox, KeyRound, Lightbulb, Link2, Lock, MessageSquare, Search, SquareCheck } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { create } from "zustand";
import { copyText, errText, openTarget, v1 } from "../lib/api";
import { useAppState, useChats } from "../lib/data";
import { ago, byPriority, entryTarget, viewOf } from "../lib/logic";
import { platformOf } from "../lib/platforms";
import { searchItems, titleOfItem, tokensOf, type ItemHit } from "../lib/search";
import { useUi } from "../lib/store";
import type { Item, ItemType, Msg } from "../lib/types";
import { typeName } from "../lib/types";
import { groupOf, identityOf, mainOf, openSecret, tailOf, unlock, useVault, useVaultUi } from "../lib/vault";
import { bumpUsage, domainOf, recentEntries, scoreVault, titleOf, type Entry } from "../lib/vaultSearch";
import { cx } from "../lib/cx";
import { EntryIcon, MasterInput, useVaultState } from "./Vault";
import { ErrorText, Pri } from "./ui";

const say = (t: string) => useUi.getState().say(t);

export const usePalette = create<{ open: boolean; set: (open: boolean) => void }>((set) => ({ open: false, set: (open) => set({ open }) }));
export const openPalette = () => usePalette.getState().set(true);

export function Palette({ enabled }: { enabled: boolean }) {
  const { open, set } = usePalette();
  useEffect(() => {
    if (!enabled) return;
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        set(!usePalette.getState().open);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [enabled, set]);
  if (!open || !enabled) return null;
  return <Panel close={() => set(false)} />;
}

type Scope = "all" | "work" | "notes" | "inbox" | "links" | "rules" | "vault";
const SCOPES: [Scope, string][] = [
  ["all", "全部"],
  ["work", "事项"],
  ["notes", "笔记"],
  ["inbox", "消息"],
  ["links", "入口"],
  ["rules", "规范"],
  ["vault", "密码"],
];
type Row = { k: "item"; id: string; score: number; hit: ItemHit } | { k: "secret"; id: string; score: number; e: Entry } | { k: "msg"; id: string; score: number; m: Msg } | { k: "unlock"; id: string; score: number };
const scopeOf = (r: Row): Scope => (r.k === "item" ? (viewOf(r.hit.item) as Scope) : r.k === "msg" ? "inbox" : "vault");

const TYPE_ICON: Record<ItemType, typeof Inbox> = { todo: SquareCheck, issue: CircleAlert, idea: Lightbulb, note: FileText, link: Link2, rule: BookMarked, inbox: Inbox };

/** 把对上的词标出来 */
function Marked({ text, toks }: { text: string; toks: string[] }) {
  if (!toks.length || !text) return <>{text}</>;
  const l = text.toLowerCase();
  const cuts: [number, number][] = [];
  for (const t of toks) for (let i = l.indexOf(t); i >= 0; i = l.indexOf(t, i + t.length)) cuts.push([i, i + t.length]);
  if (!cuts.length) return <>{text}</>;
  cuts.sort((a, b) => a[0] - b[0]);
  const out: ReactNode[] = [];
  let at = 0;
  for (const [a, b] of cuts) {
    if (a < at) continue;
    out.push(<Fragment key={a + "t"}>{text.slice(at, a)}</Fragment>);
    out.push(
      <mark key={a} className="rounded-[3px] bg-accent-soft text-inherit">
        {text.slice(a, b)}
      </mark>,
    );
    at = b;
  }
  out.push(<Fragment key="end">{text.slice(at)}</Fragment>);
  return <>{out}</>;
}

function Panel({ close }: { close: () => void }) {
  const items = useAppState().data?.items ?? [];
  const chats = useChats().data ?? [];
  const vault = useVaultState().data;
  const vks = useVault((s) => s.vks);
  const [q, setQ] = useState("");
  const [dq, setDq] = useState("");
  const [scope, setScope] = useState<Scope>("all");
  const [at, setAt] = useState(0);
  const [unlocking, setUnlocking] = useState(false);
  const [p, setP] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const toks = useMemo(() => tokensOf(q), [q]);
  const hasVault = !!vault?.keys.length;

  // 聊天记录在主机上搜：等打字停一下再问
  useEffect(() => {
    const t = window.setTimeout(() => setDq(q.trim()), 220);
    return () => window.clearTimeout(t);
  }, [q]);
  const msgs = useQuery({
    queryKey: ["palette-msgs", dq],
    queryFn: () => v1<{ messages: Msg[] }>("GET", `/inbox/messages?q=${encodeURIComponent(dq)}&limit=30`).then((r) => r.messages ?? []),
    enabled: dq.length >= 2 && chats.length > 0,
    staleTime: 30_000,
  }).data;

  const entries = useMemo<Entry[]>(() => (vault && vks ? vault.secrets.map((s) => ({ s, f: openSecret(s, vks) })).filter((e) => e.f) : []), [vault, vks]);
  const rows = useMemo<Row[]>(() => {
    if (!toks.length) {
      // 还没打字：要紧的事项、最近改过的、密码库里常用的
      const focus = items.filter((i) => viewOf(i) === "work" && !i.done && (i.pinned || i.priority === "P0" || i.priority === "P1")).sort(byPriority).slice(0, 4);
      const recent = items
        .filter((i) => !focus.includes(i) && !i.done && i.type !== "inbox")
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 6);
      const used = recentEntries(entries, 3);
      return [
        ...[...focus, ...recent].map((item): Row => ({ k: "item", id: item.id, score: 0, hit: { item, score: 0, title: titleOfItem(item), snippet: "" } })),
        ...used.map((e): Row => ({ k: "secret", id: "s:" + e.s.id, score: 0, e })),
      ];
    }
    const found: Row[] = [
      ...searchItems(items, q).map((hit): Row => ({ k: "item", id: hit.item.id, score: hit.score, hit })),
      ...scoreVault(entries, q).map(({ e, score }): Row => ({ k: "secret", id: "s:" + e.s.id, score, e })),
    ].sort((a, b) => b.score - a.score);
    // 聊天记录没有分数，排在后面（新的在前）
    const tail: Row[] = (dq === q.trim() ? (msgs ?? []) : []).map((m): Row => ({ k: "msg", id: "m:" + m.id, score: 0, m }));
    return [...found, ...tail];
  }, [items, entries, msgs, q, dq, toks]);

  const counts = useMemo(() => {
    const c = new Map<Scope, number>();
    for (const r of rows) c.set(scopeOf(r), (c.get(scopeOf(r)) ?? 0) + 1);
    return c;
  }, [rows]);
  const shown = useMemo(() => {
    const some = rows.filter((r) => scope === "all" || scopeOf(r) === scope);
    // 「全部」里聊天记录只露几条，免得把别的挤下去；点「消息」看全
    let nMsg = 0;
    const cut = scope === "all" ? some.filter((r) => r.k !== "msg" || ++nMsg <= 5) : some;
    const out = cut.slice(0, 40);
    // 密码库锁着：留一行，回车输主密码后一起搜
    if (hasVault && !vks && toks.length && (scope === "all" || scope === "vault")) out.push({ k: "unlock", id: "unlock", score: 0 });
    return out;
  }, [rows, scope, hasVault, vks, toks]);

  useEffect(() => setAt(0), [q, scope]);
  useEffect(() => {
    if (!unlocking) input.current?.focus();
  }, [unlocking]);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [at]);

  /* ---- 打开 ---- */
  const goItem = (it: Item, peek: boolean) => {
    const ui = useUi.getState();
    // 收件箱里随手发的没有单独的阅读页：在右侧面板里看
    if (peek || it.type === "inbox") ui.openPeek(it.id);
    else {
      useUi.setState({ cat: null, tag: null, q: "", dev: null });
      ui.setView(viewOf(it));
      useUi.getState().select(it.id);
    }
    close();
  };
  const copySecret = async (e: Entry, what: "main" | "id") => {
    const f = e.f!;
    const hit = f.kind === "raw" ? { spec: { label: "原文" }, value: f.raw ?? "" } : what === "id" ? identityOf(f) : mainOf(f);
    const label = hit?.spec.label.replace(/（.*）$/, "") ?? (what === "id" ? "账号" : "密码");
    if (!hit?.value) return say(`「${titleOf(e)}」没有填${label}`);
    if (!(await copyText(hit.value))) return say("复制失败");
    bumpUsage(e.s.id);
    useVault.getState().touch();
    say(`已复制「${titleOf(e)}」的${label}`);
    close();
  };
  const run = async (r: Row, alt: boolean) => {
    if (r.k === "unlock") return setUnlocking(true);
    if (r.k === "item") {
      const it = r.hit.item;
      const target = it.type === "link" ? entryTarget(it) : null;
      if (target && !alt) {
        const how = await openTarget(target);
        say(how === "copied" ? "已复制：" + target : "已打开：" + it.title);
        return close();
      }
      return goItem(it, alt && it.type !== "link");
    }
    if (r.k === "msg") {
      const ui = useUi.getState();
      ui.setView("inbox");
      if (r.m.chat) ui.setIbx(r.m.chat);
      return close();
    }
    if (alt) {
      useVaultUi.getState().setSel(r.e.s.id);
      useUi.getState().setView("vault");
      return close();
    }
    return copySecret(r.e, "main");
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") return close();
    const cur = shown[at];
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (shown.length) setAt((i) => (i + (e.key === "ArrowDown" ? 1 : shown.length - 1)) % shown.length);
    } else if (e.key === "Enter" && !e.nativeEvent.isComposing && cur) {
      e.preventDefault();
      run(cur, e.ctrlKey || e.metaKey);
    } else if (e.key === "Tab") {
      e.preventDefault();
      // 密码库的条目：Tab 复制账号；别的：换一个范围
      if (cur?.k === "secret") copySecret(cur.e, "id");
      else {
        const live = SCOPES.map((s) => s[0]).filter((s) => s === "all" || counts.get(s));
        setScope(live[(live.indexOf(scope) + (e.shiftKey ? live.length - 1 : 1)) % live.length] ?? "all");
      }
    }
  };
  const doUnlock = async () => {
    if (!vault || !p || busy) return;
    setBusy(true);
    setErr("");
    try {
      await unlock(vault.keys, p);
      setP("");
      setUnlocking(false);
    } catch (e) {
      setErr(errText(e));
    }
    setBusy(false);
  };

  const cur = shown[at];
  const hints =
    cur?.k === "secret"
      ? ["回车 复制密码（信用卡是卡号）", "Tab 复制账号", "Ctrl+回车 在密码库里打开"]
      : cur?.k === "msg"
        ? ["回车 打开这个聊天"]
        : cur?.k === "unlock"
          ? ["回车 输入主密码"]
          : cur?.k === "item" && cur.hit.item.type === "link"
            ? ["回车 打开网址或路径", "Ctrl+回车 看这一条", "Tab 换范围"]
            : ["回车 打开", "Ctrl+回车 在右侧面板里看", "Tab 换范围"];

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-[rgb(15_18_22/0.38)] px-4 pt-[11vh] backdrop-blur-[2px]" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div role="dialog" aria-label="搜索" className="flex w-full max-w-[680px] flex-col overflow-hidden rounded-[18px] bg-surface shadow-3" onKeyDown={(e) => e.key === "Escape" && close()}>
        {unlocking ? (
          <div className="flex flex-col gap-3 p-5">
            <span className="flex items-center gap-2 text-sm text-fg-2">
              <Lock className="size-4" />
              输入主密码，把密码库也一起搜
            </span>
            <MasterInput label="主密码" value={p} onChange={setP} onEnter={doUnlock} autoFocus placeholder={busy ? "正在解锁…" : "主密码，回车解锁"} />
            <ErrorText>{err}</ErrorText>
            <button className="self-start text-xs text-muted hover:text-fg" onClick={() => setUnlocking(false)}>
              不解锁，回去接着搜
            </button>
          </div>
        ) : (
          <>
            <label className="flex h-[54px] shrink-0 items-center gap-2.5 px-5 text-muted">
              <Search className="size-[18px]" />
              <input
                ref={input}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={onKey}
                placeholder="搜全部：事项、笔记、消息、入口、密码库…"
                aria-label="搜索全部"
                autoComplete="off"
                spellCheck={false}
                className="min-w-0 grow bg-transparent text-[15px] text-fg outline-none placeholder:text-faint"
              />
            </label>
            {toks.length > 0 && (
              <div className="flex flex-wrap gap-1 px-4 pb-1.5">
                {SCOPES.filter(([s]) => s === "all" || counts.get(s)).map(([s, name]) => (
                  <button key={s} aria-pressed={scope === s} onClick={() => (setScope(s), input.current?.focus())} className={cx("rounded-lg px-2.5 py-1 text-[12.5px]", scope === s ? "bg-surface-3 font-medium text-fg" : "text-muted hover:bg-surface-2")}>
                    {name} <span className="text-faint">{s === "all" ? rows.length : counts.get(s)}</span>
                  </button>
                ))}
              </div>
            )}
            <div ref={list} role="listbox" aria-label="结果" className="scroll-quiet flex max-h-[52vh] flex-col gap-0.5 overflow-y-auto px-2 pb-2">
              {!toks.length && shown.length > 0 && <span className="px-3 pt-1 pb-0.5 text-xs text-faint">要紧的和最近的</span>}
              {shown.map((r, i) => {
                const on = i === at;
                const base = cx("flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2", on && "bg-surface-3");
                const props = { role: "option" as const, "aria-selected": on, onMouseMove: () => setAt(i), onClick: (e: React.MouseEvent) => run(r, e.ctrlKey || e.metaKey), className: base };
                if (r.k === "unlock")
                  return (
                    <div key={r.id} {...props}>
                      <Lock className="size-[18px] shrink-0 text-muted" strokeWidth={1.8} />
                      <span className="grow text-[13.5px] text-fg-2">密码库锁着，没有搜它。输入主密码后一起搜</span>
                    </div>
                  );
                if (r.k === "msg") {
                  const chat = chats.find((c) => c.id === r.m.chat);
                  return (
                    <div key={r.id} {...props}>
                      <MessageSquare className="size-[18px] shrink-0 text-muted" strokeWidth={1.8} />
                      <span className="flex min-w-0 grow flex-col">
                        <span className="line-clamp-2 text-[13.5px] text-fg">
                          <Marked text={r.m.text.replace(/\s+/g, " ").slice(0, 160)} toks={toks} />
                        </span>
                        <span className="truncate text-xs text-muted">
                          {r.m.sender} · {chat?.name ?? "聊天记录"} · {r.m.time.slice(0, 16)}
                        </span>
                      </span>
                      <span className="shrink-0 text-xs text-faint">聊天记录</span>
                    </div>
                  );
                }
                if (r.k === "secret") {
                  const f = r.e.f!;
                  return (
                    <div key={r.id} {...props}>
                      <EntryIcon e={r.e} size={19} />
                      <span className="flex min-w-0 grow flex-col">
                        <span className="truncate text-[14px] font-semibold">
                          <Marked text={titleOf(r.e)} toks={toks} />
                        </span>
                        <span className="truncate font-mono text-xs text-muted">
                          {f.kind === "raw" ? (f.raw ?? "").replace(/\s+/g, " ").slice(0, 70) : [f.username || (f.card ? tailOf(f.card) : ""), platformOf(f) ? "" : domainOf(f.url), groupOf(f)].filter(Boolean).join(" · ")}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1 text-xs text-faint">
                        <KeyRound className="size-3.5" />
                        密码库
                      </span>
                    </div>
                  );
                }
                const it = r.hit.item;
                const Icon = TYPE_ICON[it.type] ?? FileText;
                return (
                  <div key={r.id} {...props}>
                    <Icon className={cx("size-[18px] shrink-0", it.done ? "text-faint" : "text-muted")} strokeWidth={1.8} />
                    <span className="flex min-w-0 grow flex-col">
                      <span className={cx("flex min-w-0 items-center gap-1.5 text-[14px] font-semibold", it.done && "text-faint line-through")}>
                        <Pri p={it.done ? undefined : it.priority} />
                        <span className="truncate">
                          <Marked text={r.hit.title} toks={toks} />
                        </span>
                      </span>
                      {(r.hit.snippet || it.category) && (
                        <span className="truncate text-xs text-muted">
                          {it.category && <span className="text-faint">{it.category}　</span>}
                          <Marked text={it.type === "link" ? entryTarget(it) || r.hit.snippet : r.hit.snippet} toks={toks} />
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 text-xs text-faint">
                      {typeName(it.type)} · {ago(it.updatedAt)}
                    </span>
                  </div>
                );
              })}
              {!shown.length && <p className="px-3 py-3 text-[13px] text-faint">{toks.length ? "没有对得上的" : "打几个字开始搜"}</p>}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 bg-surface-2/60 px-5 py-2 text-[11.5px] text-muted">
              {hints.map((h) => (
                <span key={h}>{h}</span>
              ))}
              <span>Esc 关闭</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
