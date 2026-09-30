/* 评论：笔记下面的评论区，和划选文字后的批注。评论里 @ 设定好的 AI（Claude Code、Codex…），它会读这篇笔记后在评论里回答。
   存在条目的 qa 字段（和以前的「问答」同一份数据）：
   thread = {id, quote, prefix, suffix, at, resolved?, turns:[{q, a, at, by}]}
   - q：人写的话（可能为空：同一条评论 @ 了多个 AI 时，后面几个 AI 的回答各占一轮）
   - a：AI 的回答（没 @ AI 时为空），by：回答的 AI */
import { AtSign, Check, Copy, CornerDownRight, FileText, MessageSquare, RotateCcw, Send, Trash2 } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { copyText, desk, errText, isApp, newId } from "../lib/api";
import { addItem, patchItem, qc, useConfig, useThisDevice } from "../lib/data";
import { buildAskPrompt, locateQuote, qaDigest, type QaSel } from "../lib/qa";
import { ls, useUi } from "../lib/store";
import type { Agent, Item, Qa, State } from "../lib/types";
import { myWorkspace } from "../lib/ws";
import { cx } from "../lib/cx";
import { Md } from "./Markdown";
import { Button } from "./ui";

const say = (t: string) => useUi.getState().say(t);
const itemOf = (id: string) => qc.getQueryData<State>(["state"])?.items.find((x) => x.id === id);

/** 能在后台回答的 AI：填了问答命令，或者是 claude / codex（自动用 -p / exec -） */
export const canAsk = (a: Agent) => !!(a.ask || "").trim() || /^(claude|codex)(\.exe|\.cmd)?\b/i.test(String(a.cmd || "").trim().split(/[\\/]/).pop() || "");

/** 评论里 @ 到的 AI（名字可能有空格，按名字长的先匹配） */
function mentioned(text: string, agents: Agent[]) {
  return agents.filter((a) => text.includes("@" + a.name)).sort((a, b) => text.indexOf("@" + a.name) - text.indexOf("@" + b.name));
}
const stripMentions = (text: string, agents: Agent[]) =>
  agents
    .slice()
    .sort((a, b) => b.name.length - a.name.length)
    .reduce((t, a) => t.split("@" + a.name).join(""), text)
    .trim();

/* ---------------------------------------------------------------- 发评论 + 叫 AI */

async function saveThread(itemId: string, fn: (list: Qa[]) => Qa[]) {
  const cur = itemOf(itemId);
  if (!cur) return;
  await patchItem(cur, { qa: fn((cur.qa || []).slice()) });
}

/** 发一条评论：新开一个 thread（带原文）或回复已有的；@ 到的 AI 各自回答 */
export async function postComment(opts: { itemId: string; text: string; sel?: Omit<QaSel, "itemId"> | null; threadId?: string; agents: Agent[]; me: { id: string; hostname: string } }) {
  const { itemId, text, sel, agents } = opts;
  const at = Date.now();
  const tid = opts.threadId || newId();
  const who = mentioned(text, agents.filter(canAsk));
  await saveThread(itemId, (list) => {
    const turn = { q: text, a: "", at, by: "" };
    const i = list.findIndex((x) => x.id === tid);
    if (i >= 0) list[i] = { ...list[i], resolved: false, turns: [...(list[i].turns || []), turn] } as Qa;
    else list.push({ id: tid, quote: sel?.quote || "", prefix: sel?.prefix || "", suffix: sel?.suffix || "", at, turns: [turn] });
    return list;
  });
  if (!who.length) return;
  const it = itemOf(itemId);
  if (!it) return;
  const thread = (it.qa || []).find((x) => x.id === tid);
  const prev = (thread?.turns || []).slice(0, -1).map((t) => ({ q: t.q || "（接着说）", a: t.a || "（没有回答）" }));
  const question = stripMentions(text, agents) || "请看看这段，说说你的看法。";
  const ws = isApp ? myWorkspace(it, opts.me) : null;
  const pend = (fn: (l: PendingQ[]) => PendingQ[]) => useUi.setState((s) => ({ qaPending: { ...s.qaPending, [itemId]: fn((s.qaPending[itemId] as PendingQ[]) || []) } }));
  await Promise.all(
    who.map(async (a) => {
      const p: PendingQ = { q: question, quote: thread?.quote || "", agent: a.name, thread: tid };
      pend((l) => [...l, p]);
      try {
        const answer = String(await desk.askAi(a, ws ? ws.path : "", buildAskPrompt(it, thread || {}, question, prev))).trim();
        await saveThread(itemId, (list) => {
          const i = list.findIndex((x) => x.id === tid);
          if (i < 0) return list;
          const turns = (list[i].turns || []).slice();
          const k = turns.findIndex((t) => t.at === at && t.q === text);
          if (k >= 0 && !turns[k].a) turns[k] = { ...turns[k], a: answer, by: a.name, at: turns[k].at };
          else turns.splice(k >= 0 ? k + 1 : turns.length, 0, { q: "", a: answer, at: Date.now(), by: a.name });
          list[i] = { ...list[i], turns };
          return list;
        });
      } catch (e) {
        say(`${a.name} 没回答成：${errText(e)}`);
      } finally {
        pend((l) => l.filter((x) => x !== p));
      }
    }),
  );
}

type PendingQ = { q: string; quote: string; agent: string; thread?: string };

/* ---------------------------------------------------------------- 输入框（@ 自动补全） */

export function useAgents() {
  const cfg = useConfig().data?.config;
  return cfg?.agents ?? [];
}

export function Composer({
  itemId,
  sel,
  threadId,
  placeholder,
  autoFocus,
  onDone,
  compact,
  initial,
}: {
  itemId: string;
  sel?: Omit<QaSel, "itemId"> | null;
  threadId?: string;
  placeholder?: string;
  autoFocus?: boolean;
  onDone?: () => void;
  compact?: boolean;
  initial?: string;
}) {
  const agents = useAgents();
  const me = useThisDevice();
  const [text, setText] = useState(() => ls.get("wb-cdraft-" + itemId + (threadId || sel?.quote || "")) || initial || "");
  const [pick, setPick] = useState<{ q: string; i: number } | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const key = "wb-cdraft-" + itemId + (threadId || sel?.quote || "");
  useEffect(() => ls.set(key, text || null), [key, text]);
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }, [text]);
  useEffect(() => {
    const el = ta.current;
    if (!autoFocus || !el) return;
    el.focus();
    el.selectionStart = el.selectionEnd = el.value.length;
  }, [autoFocus]);

  const options = pick ? agents.filter((a) => a.name.toLowerCase().includes(pick.q.toLowerCase())) : [];
  const onInput = (v: string) => {
    setText(v);
    const el = ta.current;
    const before = v.slice(0, el ? el.selectionStart : v.length);
    const m = before.match(/@([^\s@]{0,20})$/);
    setPick(m && agents.length ? { q: m[1], i: 0 } : null);
  };
  const choose = (a: Agent) => {
    const el = ta.current!;
    const pos = el.selectionStart;
    const before = text.slice(0, pos).replace(/@([^\s@]{0,20})$/, "@" + a.name + " ");
    const next = before + text.slice(pos);
    setText(next);
    setPick(null);
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = before.length;
    });
  };
  const send = async () => {
    const t = text.trim();
    if (!t) return;
    setText("");
    ls.set(key, null);
    onDone?.();
    try {
      await postComment({ itemId, text: t, sel, threadId, agents, me });
    } catch (e) {
      say("评论没发出去：" + errText(e));
      setText(t);
    }
  };
  const who = mentioned(text, agents);

  return (
    <div className="relative">
      <div className={cx("flex items-end gap-2 rounded-xl bg-surface-2/70 py-1.5 pr-1.5 pl-3 transition-shadow focus-within:bg-surface focus-within:shadow-2", compact && "rounded-lg")}>
        <textarea
          ref={ta}
          rows={1}
          value={text}
          onChange={(e) => onInput(e.target.value)}
          onKeyDown={(e) => {
            if (pick && options.length) {
              if (e.key === "ArrowDown") return e.preventDefault(), setPick({ ...pick, i: (pick.i + 1) % options.length });
              if (e.key === "ArrowUp") return e.preventDefault(), setPick({ ...pick, i: (pick.i - 1 + options.length) % options.length });
              if (e.key === "Enter" || e.key === "Tab") return e.preventDefault(), choose(options[pick.i]);
              if (e.key === "Escape") return e.preventDefault(), e.stopPropagation(), setPick(null);
            }
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
            if (e.key === "Escape" && onDone) {
              e.stopPropagation();
              onDone();
            }
          }}
          placeholder={placeholder || (isApp ? "写评论，输入 @ 可以叫 AI 来回答…" : "写评论…")}
          className="scroll-quiet min-w-0 grow resize-none self-center bg-transparent py-1 text-[13.5px] leading-6 outline-none placeholder:text-faint"
        />
        {isApp && agents.length > 0 && (
          <button
            title="@ 一个 AI"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              const el = ta.current!;
              const pos = el.selectionStart ?? text.length;
              const pre = text.slice(0, pos);
              const next = pre + (pre && !/\s$/.test(pre) ? " @" : "@") + text.slice(pos);
              onInput(next);
              requestAnimationFrame(() => {
                el.focus();
                el.selectionStart = el.selectionEnd = pos + (next.length - text.length);
                onInput(next);
              });
            }}
            className="grid size-8 shrink-0 place-items-center rounded-lg text-muted hover:bg-surface-3 hover:text-accent [&_svg]:size-4"
          >
            <AtSign />
          </button>
        )}
        <button
          title={who.length ? `发送，并请 ${who.map((a) => a.name).join("、")} 回答` : "发送（回车）"}
          disabled={!text.trim()}
          onClick={send}
          className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent text-on-accent disabled:opacity-40 [&_svg]:size-4"
        >
          <Send />
        </button>
      </div>
      {pick && options.length > 0 && (
        <div className="absolute bottom-full left-2 z-30 mb-1 w-56 rounded-xl bg-surface p-1 shadow-3" onMouseDown={(e) => e.preventDefault()}>
          {options.map((a, i) => (
            <button
              key={a.name}
              onClick={() => choose(a)}
              className={cx("flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px]", i === pick.i ? "bg-accent-soft text-accent-strong" : "text-fg-2")}
            >
              <span className="grid size-5 place-items-center rounded-md bg-accent/10 text-[11px] font-bold text-accent">{a.name.slice(0, 1)}</span>
              <span className="grow truncate">{a.name}</span>
              {!canAsk(a) && <span className="text-[11px] text-faint">需填问答命令</span>}
            </button>
          ))}
        </div>
      )}
      {who.some((a) => !canAsk(a)) && (
        <div className="mt-1 text-xs text-warn-fg">
          {who.filter((a) => !canAsk(a)).map((a) => a.name).join("、")} 还没有问答命令，不会自动回答（在「设置」里给它填一个，比如 claude -p）。
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- 一条评论（thread） */

function highlightMentions(text: string, agents: Agent[]) {
  if (!agents.length) return text;
  const names = agents.map((a) => a.name).sort((a, b) => b.length - a.length);
  const re = new RegExp("(" + names.map((n) => "@" + n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")", "g");
  return text.split(re).map((p, i) => (i % 2 ? <span key={i} className="rounded bg-accent-soft px-1 font-medium text-accent-strong">{p}</span> : p));
}

const avatar = (name: string, ai: boolean) => (
  <span className={cx("grid size-6 shrink-0 place-items-center rounded-full text-[11px] font-bold", ai ? "bg-accent/10 text-accent" : "bg-surface-3 text-fg-2")}>{name.slice(0, 1)}</span>
);

function Thread({ it, q, lost, onJump }: { it: Item; q: Qa; lost: boolean; onJump: () => void }) {
  const agents = useAgents();
  const pending = ((useUi((s) => s.qaPending[it.id]) as PendingQ[] | undefined) || []).filter((p) => p.thread === q.id);
  const [reply, setReply] = useState(false);
  const [armed, setArmed] = useState(false);
  const resolved = !!(q as Qa & { resolved?: boolean }).resolved;
  const msgs = (q.turns || []).flatMap((t, i) => [
    ...(t.q ? [{ key: i + "q", who: "我", ai: false, text: t.q, at: t.at }] : []),
    ...(t.a ? [{ key: i + "a", who: t.by || "AI", ai: true, text: t.a, at: t.at }] : []),
  ]);
  const set = (ch: Partial<Qa> & { resolved?: boolean }) => saveThread(it.id, (list) => list.map((x) => (x.id === q.id ? { ...x, ...ch } : x)));
  return (
    <div data-qa-card={q.id} className={cx("group/th flex flex-col gap-2.5 rounded-[14px] p-3.5 transition-colors", resolved ? "opacity-60" : "bg-surface-2/60")}>
      {q.quote && (
        <button className="line-clamp-2 border-l-2 border-mark-fg/40 pl-2 text-left text-xs text-muted hover:text-fg" title="定位到原文" onClick={onJump}>
          {q.quote}
          {lost && <span className="ml-1.5 rounded bg-danger-soft px-1 text-danger">原文已删改</span>}
        </button>
      )}
      {msgs.map((m) => (
        <div key={m.key} className="flex gap-2.5">
          {avatar(m.who, m.ai)}
          <div className="min-w-0 grow">
            <div className="flex items-baseline gap-2 text-xs">
              <b className="text-fg">{m.who}</b>
              <span className="text-faint">{new Date(m.at).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
            </div>
            {m.ai ? <Md src={m.text} className="!text-[13.5px] !leading-[1.75]" /> : <div className="text-[13.5px] leading-relaxed whitespace-pre-wrap text-fg-2">{highlightMentions(m.text, agents)}</div>}
          </div>
        </div>
      ))}
      {pending.map((p, i) => (
        <div key={"p" + i} className="flex items-center gap-2.5 text-xs text-muted">
          {avatar(p.agent, true)}
          <span className="size-3 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          {p.agent} 正在看这篇笔记…
        </div>
      ))}
      <div className="flex items-center gap-0.5 text-xs">
        <Button tone="ghost" className="h-7 px-2 text-xs" onClick={() => setReply((v) => !v)}>
          <CornerDownRight className="size-3.5" />
          回复
        </Button>
        <Button
          tone="ghost"
          className="h-7 px-2 text-xs"
          onClick={async () => say((await copyText([q.quote ? "> " + q.quote.replace(/\n/g, "\n> ") : "", ...msgs.map((m) => `**${m.who}：** ${m.text}`)].filter(Boolean).join("\n\n"))) ? "已复制" : "复制失败")}
        >
          <Copy className="size-3.5" />
          复制
        </Button>
        <Button tone="ghost" className="h-7 px-2 text-xs" onClick={() => set({ resolved: !resolved })}>
          {resolved ? <RotateCcw className="size-3.5" /> : <Check className="size-3.5" />}
          {resolved ? "重新打开" : "解决"}
        </Button>
        <span className="grow" />
        <Button
          tone="danger"
          className={cx("h-7 px-2 text-xs opacity-0 group-hover/th:opacity-100", armed && "bg-danger-soft opacity-100")}
          onClick={() => (armed ? saveThread(it.id, (list) => list.filter((x) => x.id !== q.id)) : setArmed(true))}
        >
          <Trash2 className="size-3.5" />
          {armed ? "再点一次删除" : "删除"}
        </Button>
      </div>
      {reply && <Composer itemId={it.id} threadId={q.id} autoFocus compact placeholder="回复，@ 可以叫 AI…" onDone={() => setReply(false)} />}
    </div>
  );
}

/* ---------------------------------------------------------------- 评论区 */

export function flash(el: Element | null | undefined) {
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.remove("flash");
  void (el as HTMLElement).offsetWidth;
  el.classList.add("flash");
}

/** 定位到评论的原文：阅读页有 <mark>；编辑页没有，就在正文里找到这段文字选中它 */
function jumpTo(root: HTMLElement | null, q: Qa) {
  if (!root || !q.quote) return;
  const m = root.querySelector(`mark[data-qa="${CSS.escape(q.id)}"]`);
  if (m) return flash(m);
  const host = root.querySelector("[data-qa-host]");
  if (!host) return;
  const nodes: Text[] = [];
  const w = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  while (w.nextNode()) nodes.push(w.currentNode as Text);
  const text = nodes.map((n) => n.nodeValue).join("");
  const s = locateQuote(text, q);
  if (s < 0) return say("原文已删改，找不到这段了");
  const e = s + q.quote.length;
  const r = document.createRange();
  let pos = 0;
  for (const n of nodes) {
    const len = n.nodeValue!.length;
    if (s >= pos && s <= pos + len) r.setStart(n, s - pos);
    if (e >= pos && e <= pos + len) {
      r.setEnd(n, e - pos);
      break;
    }
    pos += len;
  }
  (r.startContainer.parentElement as HTMLElement | null)?.scrollIntoView({ behavior: "smooth", block: "center" });
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(r);
}

export function CommentsSection({ it, lost, root }: { it: Item; lost: Set<string>; root: React.RefObject<HTMLElement | null> }) {
  const [showResolved, setShowResolved] = useState(false);
  const pendingNew = ((useUi((s) => s.qaPending[it.id]) as PendingQ[] | undefined) || []).filter((p) => !p.thread);
  const all = it.qa || [];
  const open = all.filter((q) => !(q as Qa & { resolved?: boolean }).resolved);
  const done = all.filter((q) => (q as Qa & { resolved?: boolean }).resolved);
  const list = useMemo(() => [...open, ...(showResolved ? done : [])].sort((a, b) => a.at - b.at), [open, done, showResolved]);
  return (
    <section className="qasec mt-12 flex flex-col gap-3" aria-label="评论" data-qa-skip>
      <h3 className="flex items-center gap-1.5 text-sm font-semibold text-muted">
        <MessageSquare className="size-4" /> 评论 <span className="font-normal text-faint">{open.length || ""}</span>
        <span className="grow" />
        {done.length > 0 && (
          <Button tone="ghost" className="h-7 px-2 text-xs" onClick={() => setShowResolved((v) => !v)}>
            {showResolved ? "隐藏已解决" : `已解决 ${done.length}`}
          </Button>
        )}
        {all.length > 0 && (
          <Button
            tone="ghost"
            className="h-7 px-2 text-xs"
            title="把这些评论和回答按原文顺序整理成一篇新笔记"
            onClick={async () => {
              const text = root.current?.querySelector("[data-qa-host]")?.textContent || "";
              const n = await addItem({ type: "note", title: `${it.title || "笔记"} · 评论整理`, body: qaDigest(it, text), category: it.category || undefined, tags: [...(it.tags || [])] }).catch(() => null);
              if (n) {
                useUi.getState().openPeek(n.id);
                say("已整理成一篇新笔记");
              }
            }}
          >
            <FileText className="size-3.5" />
            整理成笔记
          </Button>
        )}
      </h3>
      {list.map((q) => (
        <Thread key={q.id} it={it} q={q} lost={lost.has(q.id)} onJump={() => jumpTo(root.current, q)} />
      ))}
      {pendingNew.map((p, i) => (
        <div key={i} className="flex items-center gap-2 text-xs text-muted">
          <span className="size-3 animate-spin rounded-full border-2 border-accent border-t-transparent" /> {p.agent} 正在看这篇笔记…
        </div>
      ))}
      {!list.length && <p className="text-xs text-faint">{isApp ? "有想法就写在这里；输入 @ 可以请 Claude Code 等 AI 读完这篇后回答。选中正文里的字也能单独评论。" : "有想法就写在这里；选中正文里的字也能单独评论。"}</p>}
      <Composer itemId={it.id} />
    </section>
  );
}

/* ---------------------------------------------------------------- 划选后的评论框 */

export function SelectionComment({ sel, at, onClose, initial }: { sel: QaSel; at: { x: number; y: number }; onClose: () => void; initial?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const down = (e: MouseEvent) => !box.current?.contains(e.target as Node) && close.current();
    const key = (e: KeyboardEvent) => e.key === "Escape" && close.current();
    const t = setTimeout(() => document.addEventListener("mousedown", down), 0);
    window.addEventListener("keydown", key);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", down);
      window.removeEventListener("keydown", key);
    };
  }, []);
  const left = Math.max(12, Math.min(at.x - 20, window.innerWidth - 392));
  const top = Math.min(at.y, window.innerHeight - 180);
  return createPortal(
    <div ref={box} className="fixed z-40 flex w-[380px] flex-col gap-2 rounded-[14px] bg-surface p-3 shadow-3" style={{ left, top }}>
      <div className="line-clamp-2 border-l-2 border-mark-fg/40 pl-2 text-xs text-muted">{sel.quote}</div>
      <Composer itemId={sel.itemId} sel={sel} initial={initial} autoFocus onDone={onClose} placeholder={isApp ? "评论这段，@ 可以叫 AI 解释…" : "评论这段…"} />
    </div>,
    document.body,
  );
}
