/* 评论：笔记下面的评论区，和划选文字后的批注。评论里 @ 设定好的 AI（Claude Code、Codex…），它会读这篇笔记后在评论里回答。
   存在条目的 qa 字段（和以前的「问答」同一份数据）：
   thread = {id, quote, prefix, suffix, at, resolved?, turns:[{q, a, at, by}]}
   - q：人写的话（可能为空：同一条评论 @ 了多个 AI 时，后面几个 AI 的回答各占一轮）
   - a：AI 的回答（没 @ AI 时为空），by：回答的 AI */
import { AtSign, Check, ChevronDown, Copy, FilePlus2, CornerDownRight, FileText, MessageSquare, RotateCcw, Send, Trash2, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import { copyText, desk, errText, isApp, newId } from "../lib/api";
import { addItem, patchItem, qc, useAppState, useConfig, useThisDevice } from "../lib/data";
import { assetRefs, buildAskPrompt, locateQuote, qaDigest, type QaSel } from "../lib/qa";
import { addLink, relatedOf } from "../lib/links";
import { ls, useUi } from "../lib/store";
import type { Agent, Item, Qa, State, Usage } from "../lib/types";
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
        // 关联的条目（岗位、简历、题库…）一起给 AI，里面的图片和附件也一起放进工作目录
        const rel = relatedOf(qc.getQueryData<State>(["state"])?.items ?? [], it).slice(0, 20);
        const files = [...new Set([it, ...rel.map((r) => r.item)].flatMap((x) => assetRefs(x.body)))];
        const r = await desk.askAi(a, ws ? ws.path : "", buildAskPrompt(it, thread || {}, question, prev, rel), files, it.id);
        const answer = String(r.text || "").trim();
        const usage = r.usage ? { usage: r.usage } : {};
        await saveThread(itemId, (list) => {
          const i = list.findIndex((x) => x.id === tid);
          if (i < 0) return list;
          const turns = (list[i].turns || []).slice();
          const k = turns.findIndex((t) => t.at === at && t.q === text);
          if (k >= 0 && !turns[k].a) turns[k] = { ...turns[k], a: answer, by: a.name, at: turns[k].at, ...usage };
          else turns.splice(k >= 0 ? k + 1 : turns.length, 0, { q: "", a: answer, at: Date.now(), by: a.name, ...usage });
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

/** 从一段文字里把 @AI 名字拆出来：返回提到的 AI 和去掉之后的文字 */
function splitMentions(text: string, agents: Agent[]) {
  const found: string[] = [];
  let rest = text;
  for (const a of agents.slice().sort((x, y) => y.name.length - x.name.length)) {
    if (!rest.includes("@" + a.name)) continue;
    found.push(a.name);
    rest = rest.split("@" + a.name).join("");
  }
  return { names: found, rest: rest.replace(/[ \t]{2,}/g, " ").replace(/^[ \t]+/, "") };
}

/** AI 头像上的字：多个词取首字母（Claude Code → CC），一个词取前两个字母（Codex → Co），名字不同就分得开 */
export function initials(name: string) {
  const w = name.trim().split(/[\s_-]+/).filter(Boolean);
  if (w.length > 1) return (w[0][0] + w[1][0]).toUpperCase();
  const n = w[0] || "?";
  return /^[a-z]/i.test(n) ? n[0].toUpperCase() + (n[1] || "").toLowerCase() : n.slice(0, 1);
}
/** 每个 AI 一个固定的颜色（暖色系里挑），头像一看就知道是谁 */
const AGENT_COLORS = ["#b0532c", "#4d6b8a", "#5f7a3a", "#8a5a9e", "#a0782a", "#3f7f7a"];
export function agentColor(name: string) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AGENT_COLORS[h % AGENT_COLORS.length];
}

/** @ 到的 AI 显示成标签：头像字 + 名字 */
export function AgentTag({ name, onRemove, small }: { name: string; onRemove?: () => void; small?: boolean }) {
  return (
    <span className={cx("inline-flex shrink-0 items-center gap-1 rounded-full bg-accent-soft pr-2 pl-0.5 align-middle font-medium text-accent-strong", small ? "h-[22px] text-[12.5px]" : "h-6 text-[13px]")}>
      <span style={{ background: agentColor(name) }} className="grid size-[18px] place-items-center rounded-full text-[9px] font-bold text-white">{initials(name)}</span>
      {name}
      {onRemove && (
        <button
          aria-label={"不叫 " + name}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onRemove}
          className="-mr-1 grid size-4 place-items-center rounded-full text-accent-strong/70 hover:bg-accent/15 hover:text-accent-strong [&_svg]:size-3"
        >
          <X />
        </button>
      )}
    </span>
  );
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
  /** 预先 @ 好的 AI，比如「问 AI」 */
  initial?: string[];
}) {
  const agents = useAgents();
  const me = useThisDevice();
  const key = "wb-cdraft-" + itemId + (threadId || sel?.quote || "");
  // 草稿按「@名字 正文」存，读回来再拆成标签
  const [text, setText] = useState(() => ls.get(key) || "");
  const [tags, setTags] = useState<string[]>(() => initial || []);
  const [pick, setPick] = useState<{ q: string; i: number } | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ls.set(key, [...tags.map((n) => "@" + n), text].join(" ").trim() || null), [key, text, tags]);
  // 手打的完整「@名字」也变成标签（配置晚到时，草稿里的也能拆出来）
  useEffect(() => {
    if (!agents.length || !text.includes("@")) return;
    const { names, rest } = splitMentions(text, agents);
    if (!names.length) return;
    setTags((t) => [...t, ...names.filter((n) => !t.includes(n))]);
    setText(rest);
  }, [agents, text]);
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

  const options = pick ? agents.filter((a) => a.name.toLowerCase().includes(pick.q.toLowerCase()) && !tags.includes(a.name)) : [];
  const onInput = (v: string, caret?: number) => {
    setText(v);
    const before = v.slice(0, caret ?? ta.current?.selectionStart ?? v.length);
    const m = before.match(/@([^\s@]{0,20})$/);
    setPick(m && agents.length ? { q: m[1], i: 0 } : null);
  };
  const choose = (a: Agent) => {
    const el = ta.current!;
    const pos = el.selectionStart;
    const before = text.slice(0, pos).replace(/@([^\s@]{0,20})$/, "");
    setText(before + text.slice(pos));
    setTags((t) => (t.includes(a.name) ? t : [...t, a.name]));
    setPick(null);
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = before.length;
    });
  };
  const send = async () => {
    const body = text.trim();
    if (!body && !tags.length) return;
    const full = [...tags.map((n) => "@" + n), body].join(" ").trim();
    setText("");
    setTags([]);
    ls.set(key, null);
    onDone?.();
    try {
      await postComment({ itemId, text: full, sel, threadId, agents, me });
    } catch (e) {
      say("评论没发出去：" + errText(e));
      setText(body);
    }
  };
  const who = agents.filter((a) => tags.includes(a.name));
  const empty = !text.trim() && !tags.length;

  return (
    <div className="relative">
      <div
        onClick={() => ta.current?.focus()}
        className={cx("flex cursor-text items-end gap-2 rounded-xl bg-surface-2 py-1.5 pr-1.5 pl-2.5 transition-colors focus-within:bg-surface-3/60", compact && "rounded-lg")}
      >
        {/* @ 到的 AI 单独一行，下面是整行宽的输入框 */}
        <div className="flex min-w-0 grow flex-col gap-1 self-center py-0.5">
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-0.5">
              {tags.map((n) => (
                <AgentTag key={n} name={n} onRemove={() => setTags((t) => t.filter((x) => x !== n))} />
              ))}
            </div>
          )}
          <textarea
            ref={ta}
            rows={1}
            value={text}
            onChange={(e) => onInput(e.target.value, e.target.selectionStart)}
            onKeyDown={(e) => {
              if (pick && options.length) {
                if (e.key === "ArrowDown") return e.preventDefault(), setPick({ ...pick, i: (pick.i + 1) % options.length });
                if (e.key === "ArrowUp") return e.preventDefault(), setPick({ ...pick, i: (pick.i - 1 + options.length) % options.length });
                if (e.key === "Enter" || e.key === "Tab") return e.preventDefault(), choose(options[pick.i]);
                if (e.key === "Escape") return e.preventDefault(), e.stopPropagation(), setPick(null);
              }
              // 光标在最前面按退格：去掉最后一个标签
              if (e.key === "Backspace" && tags.length && e.currentTarget.selectionStart === 0 && e.currentTarget.selectionEnd === 0) {
                e.preventDefault();
                setTags((t) => t.slice(0, -1));
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
            placeholder={tags.length ? "想问什么…" : placeholder || (isApp ? "写评论，输入 @ 可以叫 AI 来回答…" : "写评论…")}
            className="scroll-quiet w-full resize-none bg-transparent px-0.5 py-0.5 text-[13.5px] leading-6 outline-none placeholder:text-faint"
          />
        </div>
        {isApp && agents.length > 0 && (
          <button
            title="@ 一个 AI"
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.stopPropagation();
              const el = ta.current!;
              const pos = el.selectionStart ?? text.length;
              const pre = text.slice(0, pos);
              const ins = pre && !/\s$/.test(pre) ? " @" : "@";
              const next = pre + ins + text.slice(pos);
              onInput(next, pos + ins.length);
              requestAnimationFrame(() => {
                el.focus();
                el.selectionStart = el.selectionEnd = pos + ins.length;
              });
            }}
            className="grid size-8 shrink-0 place-items-center rounded-lg text-muted hover:bg-surface-3 hover:text-fg [&_svg]:size-4"
          >
            <AtSign />
          </button>
        )}
        <button
          title={who.length ? `发送，并请 ${who.map((a) => a.name).join("、")} 回答` : "发送（回车）"}
          disabled={empty}
          onClick={(e) => {
            e.stopPropagation();
            send();
          }}
          className="grid size-8 shrink-0 place-items-center rounded-lg bg-ink text-on-ink disabled:opacity-30 [&_svg]:size-4"
        >
          <Send />
        </button>
      </div>
      {pick && options.length > 0 && (
        <div className="absolute bottom-full left-2 z-30 mb-1 w-60 rounded-xl bg-surface p-1 shadow-3" onMouseDown={(e) => e.preventDefault()}>
          {options.map((a, i) => (
            <button
              key={a.name}
              onClick={() => choose(a)}
              className={cx("flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px]", i === pick.i ? "bg-surface-2 text-fg" : "text-fg-2")}
            >
              <span style={{ background: agentColor(a.name) }} className="grid size-5 place-items-center rounded-full text-[9.5px] font-bold text-white">{initials(a.name)}</span>
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
  const re = new RegExp("@(" + names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")", "g");
  return text.split(re).map((p, i) => (i % 2 ? <AgentTag key={i} name={p} small /> : p));
}

/* ---------------------------------------------------------------- AI 的回答：默认收起，记住每条的展开状态 */

const useAnsOpen = create<{ open: Record<string, 1>; toggle: (id: string) => void }>((set) => ({
  open: (() => {
    try {
      return JSON.parse(ls.get("wb-ans-open") || "{}");
    } catch {
      return {};
    }
  })(),
  toggle: (id) =>
    set((s) => {
      const open = { ...s.open };
      if (open[id]) delete open[id];
      else open[id] = 1;
      // 只留最近的 500 条，免得越存越多
      const keys = Object.keys(open);
      if (keys.length > 500) keys.slice(0, keys.length - 500).forEach((k) => delete open[k]);
      ls.set("wb-ans-open", JSON.stringify(open));
      return { open };
    }),
}));

/** 1234 → 1.2k */
const kfmt = (n: number) => (n >= 10000 ? Math.round(n / 1000) + "k" : n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n));

function UsageLine({ u }: { u: Usage }) {
  const tip = [`输入 ${u.input.toLocaleString()} tokens`, u.cached ? `（其中缓存命中 ${u.cached.toLocaleString()}）` : "", `\n输出 ${u.output.toLocaleString()} tokens`, u.cost_usd != null ? `\n约 $${u.cost_usd.toFixed(4)}` : ""].join("");
  return (
    <span className="text-[11px] text-faint tabular-nums" title={tip}>
      输入 {kfmt(u.input)} · 输出 {kfmt(u.output)} tokens
    </span>
  );
}

/** 把一条 AI 回答存成笔记，并关联回这条（标签「产出」）；标题取回答里的第一个标题，没有就用问题 */
async function saveAnswer(it: Item, q: Qa, ti: number, agents: Agent[]) {
  const t = (q.turns || [])[ti];
  if (!t?.a) return;
  const ask = [...(q.turns || []).slice(0, ti + 1)].reverse().find((x) => x.q)?.q || "";
  const h = t.a.match(/^#{1,3}\s+(.+)$/m)?.[1];
  const qTitle = stripMentions(ask, agents);
  const title = (h && !/^(结论|总结|回答)$/.test(h.trim()) ? h : qTitle || h || "AI 回答").replace(/[*`#]/g, "").trim().slice(0, 40);
  const quote = q.quote ? q.quote.split("\n").map((l) => "> " + l).join("\n") + "\n\n" : "";
  const n = await addItem({ type: "note", title, body: quote + t.a, category: it.category || undefined, tags: [...(it.tags || [])] }).catch(() => null);
  if (!n) return say("没存成");
  await addLink(it, n.id, "产出").catch(() => {});
  await saveThread(it.id, (list) => list.map((x) => (x.id === q.id ? { ...x, turns: x.turns.map((y, i) => (i === ti ? { ...y, saved: n.id } : y)) } : x)));
  useUi.getState().say(`已存为笔记「${title}」并关联`, { label: "打开", run: () => useUi.getState().openPeek(n.id) });
}

function Answer({ id, text, usage, saved, onSave }: { id: string; text: string; usage?: Usage; saved?: string; onSave?: () => void }) {
  const savedItem = useAppState().data?.items.find((x) => x.id === saved);
  const open = useAnsOpen((s) => !!s.open[id]);
  const toggle = useAnsOpen((s) => s.toggle);
  const box = useRef<HTMLDivElement>(null);
  const [long, setLong] = useState(true);
  // 本来就很短的回答不用收起
  useLayoutEffect(() => {
    const el = box.current;
    if (el) setLong(el.scrollHeight > 130);
  }, [text]);
  return (
    <div>
      <div
        ref={box}
        className={cx("relative", !open && long && "max-h-[112px] overflow-hidden [mask-image:linear-gradient(to_bottom,black_55%,transparent)]")}
        onClick={() => !open && long && toggle(id)}
      >
        <Md src={text} className={cx("!text-[13.5px] !leading-[1.75]", !open && long && "cursor-pointer")} />
      </div>
      {(long || usage || onSave) && (
        <div className="mt-0.5 flex flex-wrap items-center gap-2">
          {long && (
            <button onClick={() => toggle(id)} className="flex items-center gap-0.5 rounded-md px-1 py-0.5 text-xs text-muted hover:bg-surface-3 hover:text-fg [&_svg]:size-3.5">
              <ChevronDown className={cx("transition-transform", open && "rotate-180")} />
              {open ? "收起" : "展开回答"}
            </button>
          )}
          {savedItem ? (
            <button onClick={() => useUi.getState().openPeek(savedItem.id)} className="flex items-center gap-1 rounded-md px-1 py-0.5 text-xs text-muted hover:bg-surface-3 hover:text-fg [&_svg]:size-3.5" title="打开存下来的笔记">
              <FileText />
              已存为「{savedItem.title}」
            </button>
          ) : (
            onSave && (
              <button onClick={onSave} className="flex items-center gap-1 rounded-md px-1 py-0.5 text-xs text-muted hover:bg-surface-3 hover:text-fg [&_svg]:size-3.5" title="存成一篇笔记，并关联到这条">
                <FilePlus2 />
                存为笔记
              </button>
            )
          )}
          {usage && <UsageLine u={usage} />}
        </div>
      )}
    </div>
  );
}

const avatar = (name: string, ai: boolean, title?: string) => (
  <span
    title={title || name}
    style={ai ? { background: agentColor(name) } : undefined}
    className={cx("grid size-6 shrink-0 place-items-center rounded-full text-[10.5px] font-bold", ai ? "text-white" : "bg-surface-3 text-fg-2")}
  >
    {ai ? initials(name) : name.slice(0, 1)}
  </span>
);

function Thread({ it, q, lost, onJump }: { it: Item; q: Qa; lost: boolean; onJump: () => void }) {
  const agents = useAgents();
  const pending = ((useUi((s) => s.qaPending[it.id]) as PendingQ[] | undefined) || []).filter((p) => p.thread === q.id);
  const [reply, setReply] = useState(false);
  const [armed, setArmed] = useState(false);
  const resolved = !!(q as Qa & { resolved?: boolean }).resolved;
  const msgs = (q.turns || []).flatMap((t, i) => [
    ...(t.q ? [{ key: i + "q", who: "我", ai: false, text: t.q, at: t.at }] : []),
    ...(t.a ? [{ key: i + "a", who: t.by || "AI", ai: true, text: t.a, at: t.at, usage: t.usage, ti: i, saved: t.saved }] : []),
  ]);
  const set = (ch: Partial<Qa> & { resolved?: boolean }) => saveThread(it.id, (list) => list.map((x) => (x.id === q.id ? { ...x, ...ch } : x)));
  return (
    <div data-qa-card={q.id} className="group/th flex flex-col gap-2.5 rounded-[14px] bg-surface-2/60 p-3.5">
      {/* 这里多是问答，标了「已解决」也照常显示，只多一个小标记 */}
      {resolved && (
        <span className="-mb-1 inline-flex items-center gap-1 self-start text-[11.5px] text-ok [&_svg]:size-3">
          <Check strokeWidth={3} />
          已解决
        </span>
      )}
      {q.quote && (
        <button className="line-clamp-2 self-start rounded-md bg-mark/70 px-1.5 py-0.5 text-left text-xs text-mark-fg hover:bg-mark" title="定位到原文" onClick={onJump}>
          {q.quote}
          {lost && <span className="ml-1.5 rounded bg-danger-soft px-1 text-danger">原文已删改</span>}
        </button>
      )}
      {msgs.map((m) => (
        // 头像就代表是谁（悬停看名字和时间），不再单独写一行名字
        <div key={m.key} className="group/msg flex gap-2.5">
          {avatar(m.who, m.ai, `${m.who} · ${new Date(m.at).toLocaleString()}`)}
          <div className="min-w-0 grow pt-px">
            {m.ai && "ti" in m && m.ti != null ? (
              <Answer id={q.id + ":" + m.key} text={m.text} usage={m.usage} saved={m.saved} onSave={() => saveAnswer(it, q, m.ti!, agents)} />
            ) : <div className="text-[13.5px] leading-relaxed whitespace-pre-wrap text-fg-2">{highlightMentions(m.text, agents)}</div>}
          </div>
          <span className="shrink-0 pt-1 text-[11px] text-faint opacity-0 transition-opacity group-hover/msg:opacity-100">
            {new Date(m.at).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
          </span>
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
  // 编辑页：交给编辑器自己选中（直接改页面选区会被编辑器盖掉）
  type PM = { view: { posAtDOM: (n: Node, o: number) => number }; chain: () => { focus: () => { setTextSelection: (r: { from: number; to: number }) => { scrollIntoView: () => { run: () => void } } } } };
  const ed = (host.closest(".ProseMirror") as (Element & { editor?: PM }) | null)?.editor;
  if (ed) {
    try {
      const from = ed.view.posAtDOM(r.startContainer, r.startOffset);
      const to = ed.view.posAtDOM(r.endContainer, r.endOffset);
      ed.chain().focus().setTextSelection({ from, to }).scrollIntoView().run();
      return;
    } catch {
      /* 退回到页面选区 */
    }
  }
  (r.startContainer.parentElement as HTMLElement | null)?.scrollIntoView({ behavior: "smooth", block: "center" });
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(r);
}

export function CommentsSection({ it, lost, root }: { it: Item; lost: Set<string>; root: React.RefObject<HTMLElement | null> }) {
  const pendingNew = ((useUi((s) => s.qaPending[it.id]) as PendingQ[] | undefined) || []).filter((p) => !p.thread);
  const all = it.qa || [];
  const list = useMemo(() => all.slice().sort((a, b) => a.at - b.at), [all]);
  return (
    <section className="qasec mt-12 flex flex-col gap-3" aria-label="评论" data-qa-skip>
      <h3 className="flex items-center gap-1.5 text-sm font-semibold text-muted">
        <MessageSquare className="size-4" /> 评论 <span className="font-normal text-faint">{all.length || ""}</span>
        <span className="grow" />
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

export function SelectionComment({ sel, at, onClose, initial }: { sel: QaSel; at: { x: number; y: number }; onClose: () => void; initial?: string[] }) {
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
  const width = Math.min(560, window.innerWidth - 24);
  const left = Math.max(12, Math.min(at.x - 40, window.innerWidth - width - 12));
  const top = Math.min(at.y, window.innerHeight - 200);
  return createPortal(
    <div ref={box} className="fixed z-40 flex flex-col gap-2 rounded-[14px] bg-surface p-3 shadow-3" style={{ left, top, width }}>
      <div className="line-clamp-2 self-start rounded-md bg-mark/70 px-1.5 py-0.5 text-xs text-mark-fg">{sel.quote}</div>
      <Composer itemId={sel.itemId} sel={sel} initial={initial} autoFocus onDone={onClose} placeholder={isApp ? "评论这段，@ 可以叫 AI 解释…" : "评论这段…"} />
    </div>,
    document.body,
  );
}
