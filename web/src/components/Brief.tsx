/* 交给 AI 之前先讨论（逻辑在 lib/brief.ts）：
   - startBrief / runRound：叫本机的 AI（桌面版，claude -p 这类）看材料、提问或者出计划，结果记到条目的 brief 里
   - BriefPanel：显示在这一条下面。回答问题 → 发给 AI → 再问或者出计划 → 你点开始 → 产出存成一篇笔记并关联回来
   - 没有能在后台回答的 AI 时（浏览器里，或者没配）走手动：复制提示词给任意 AI，把它的回复贴回来
   - 导出上下文：这件事的全部材料打成一个压缩包（lib/exportContext.ts） */
import { Bot, ChevronDown, ClipboardPaste, Copy, FileDown, Play, RotateCw, Send, Sparkles, SquareTerminal, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { copyText, errText, isApp, openTarget } from "../lib/api";
import { askAi } from "../lib/aiRuns";
import { applyReply, briefDigest, briefOf, buildBriefPrompt, buildRevisePrompt, buildWorkPrompt, openQuestions, parseBrief, type Brief, type BriefQ } from "../lib/brief";
import { addItem, patchItem, qc, useConfig, useThisDevice } from "../lib/data";
import { Dialog, openDialog } from "../lib/dialog";
import { buildContextZip, saveFile } from "../lib/exportContext";
import { addLink, relatedOf } from "../lib/links";
import { ago, buildPrompt, noteTitle } from "../lib/logic";
import { dirOf, projectAsRelated, projectOf, projectsOf } from "../lib/projects";
import { assetRefs } from "../lib/qa";
import { ls, useUi } from "../lib/store";
import type { Agent, Item, State } from "../lib/types";
import { myWorkspace } from "../lib/ws";
import { cx } from "../lib/cx";
import { AiLive } from "./AiLive";
import { canAsk } from "./Comments";
import { Md } from "./Markdown";
import { Button, Chip, ConfirmButton, Pick, textareaCls } from "./ui";

const say = (t: string, action?: { label: string; run: () => void }) => useUi.getState().say(t, action);
const itemOf = (id: string) => qc.getQueryData<State>(["state"])?.items.find((x) => x.id === id);
const allItems = () => qc.getQueryData<State>(["state"])?.items ?? [];
/** 手动模式下 brief.agent 记的名字 */
const MANUAL = "手动";

/** 正在后台忙的（按条目）：在问、在做、在导出；err 是上一次没成的原因 */
const useBriefRun = create<{ busy: Record<string, string>; err: Record<string, string> }>(() => ({ busy: {}, err: {} }));
const setBusy = (id: string, what: string | null) => useBriefRun.setState((s) => ({ busy: { ...s.busy, [id]: what ?? "" } }));
const setErr = (id: string, e: string) => useBriefRun.setState((s) => ({ err: { ...s.err, [id]: e } }));

const saveBrief = (it: Item, brief: Brief | null) => (brief ? patchItem(it, { brief }) : patchItem(it, { brief: null }));

/** 给 AI 的材料：这一条、关联的条目、它们里面的附件 */
function material(it: Item) {
  // 所属的项目排在最前面：它的说明和文件夹是这件事的背景
  const rel = [...projectAsRelated(it, allItems()), ...relatedOf(allItems(), it).slice(0, 20)];
  const files = [...new Set([it, ...rel.map((r) => r.item)].flatMap((x) => assetRefs(x.body)))];
  return { rel, files };
}

/** AI 在哪个文件夹里干活：这一条展开成的项目目录，没有就用所属项目在这台电脑上的文件夹 */
function cwdOf(it: Item, me: { id: string; hostname: string }) {
  return myWorkspace(it, me)?.path || dirOf(projectOf(it, projectsOf(allItems())), me);
}

/** 叫 AI 走一轮：提问，或者出计划。force = 别问了直接出计划 */
async function runRound(itemId: string, agent: Agent, me: { id: string; hostname: string }, force = false) {
  const it = itemOf(itemId);
  if (!it || useBriefRun.getState().busy[itemId]) return;
  setBusy(itemId, force ? "正在整理计划…" : briefOf(it)?.rounds.length ? "正在看你的回答…" : "正在看材料、准备问题…");
  setErr(itemId, "");
  try {
    const { rel, files } = material(it);
    const r = await askAi(agent, cwdOf(it, me), buildBriefPrompt(it, briefOf(it), rel, force), files, it.id);
    const cur = itemOf(itemId);
    if (!cur) return;
    const next = applyReply(briefOf(cur), agent.name, parseBrief(r.text));
    await saveBrief(cur, next);
    if (useUi.getState().peek?.id !== itemId && useUi.getState().selected[useUi.getState().view] !== itemId)
      say(next.status === "ready" ? `${agent.name} 给「${noteTitle(cur)}」出了计划，等你确认` : `${agent.name} 对「${noteTitle(cur)}」有 ${openQuestions(next).length} 个问题要问你`, { label: "去看", run: () => useUi.getState().openPeek(itemId) });
  } catch (e) {
    setErr(itemId, errText(e));
  } finally {
    setBusy(itemId, null);
  }
}

/** 开工：让 AI 按计划产出一篇笔记，关联回这一条 */
async function runWork(itemId: string, agent: Agent, me: { id: string; hostname: string }) {
  const it = itemOf(itemId);
  const b = briefOf(it);
  if (!it || !b || useBriefRun.getState().busy[itemId]) return;
  setBusy(itemId, "正在做…（内容多的话要几分钟）");
  setErr(itemId, "");
  try {
    const { rel, files } = material(it);
    const r = await askAi(agent, cwdOf(it, me), buildWorkPrompt(it, b, rel), files, it.id);
    await saveResult(itemId, r.text, r.session);
  } catch (e) {
    setErr(itemId, errText(e));
  } finally {
    setBusy(itemId, null);
  }
}

/** 做完了不满意：按意见接着改，改好的替换掉产出那篇笔记（可以撤销）。
    能接着上一次对话就接着说（它记得自己看过、做过什么，不用从头再来）；接不上（换了电脑、对话太旧）就把讨论、计划和上一版都带上重新说 */
async function runRevise(itemId: string, agent: Agent, me: { id: string; hostname: string }, note: string) {
  const it = itemOf(itemId);
  const b = briefOf(it);
  if (!it || !b || !note.trim() || useBriefRun.getState().busy[itemId]) return;
  setBusy(itemId, "正在按你的意见改…");
  setErr(itemId, "");
  try {
    const { rel, files } = material(it);
    const old = b.resultId ? itemOf(b.resultId) : undefined;
    const prev = old ? { title: noteTitle(old), body: old.body || "" } : null;
    let r;
    try {
      if (!b.session) throw new Error("no session");
      r = await askAi(agent, cwdOf(it, me), buildRevisePrompt(it, b, rel, note, prev, true), [], it.id, "", b.session);
    } catch (e) {
      if (b.session && /已停止/.test(errText(e))) throw e;
      r = await askAi(agent, cwdOf(it, me), buildRevisePrompt(it, b, rel, note, prev, false), files, it.id);
    }
    const out = String(r.text || "").trim();
    if (!out) throw new Error("AI 没有返回内容");
    const m = out.match(/^#\s+(.+)\n?/);
    const title = (m?.[1] || prev?.title || noteTitle(it) + "（AI 产出）").replace(/[*`#]/g, "").trim().slice(0, 60);
    const body = (m ? out.slice(m[0].length) : out).trim();
    let resultId = old?.id;
    if (old) await patchItem(old, { title, body });
    else {
      const n = await addItem({ type: "note", title, body, category: it.category || undefined, tags: [...(it.tags || [])] });
      await addLink(it, n.id, "产出").catch(() => {});
      resultId = n.id;
    }
    const cur = itemOf(itemId);
    const cb = briefOf(cur);
    if (cur && cb) await saveBrief(cur, { ...cb, status: "done", resultId, session: r.session || cb.session, revisions: [...(cb.revisions ?? []), { at: Date.now(), note: note.trim() }] });
    say(`改好了，更新了「${title}」`, {
      label: old ? "撤销" : "打开",
      run: () => {
        if (!old) return useUi.getState().openPeek(resultId!);
        const now = itemOf(old.id);
        if (now) patchItem(now, { title: old.title, body: old.body }).catch(() => {});
      },
    });
  } catch (e) {
    setErr(itemId, errText(e));
  } finally {
    setBusy(itemId, null);
  }
}

/** 把 AI 的成品存成笔记：第一行的一级标题当标题 */
async function saveResult(itemId: string, text: string, session?: string) {
  const it = itemOf(itemId);
  const out = String(text || "").trim();
  if (!it) return;
  if (!out) throw new Error("AI 没有返回内容");
  const m = out.match(/^#\s+(.+)\n?/);
  const title = (m?.[1] || noteTitle(it) + "（AI 产出）").replace(/[*`#]/g, "").trim().slice(0, 60);
  const n = await addItem({ type: "note", title, body: (m ? out.slice(m[0].length) : out).trim(), category: it.category || undefined, tags: [...(it.tags || [])] });
  await addLink(it, n.id, "产出").catch(() => {});
  const cur = itemOf(itemId);
  const b = briefOf(cur);
  if (cur && b) await saveBrief(cur, { ...b, status: "done", resultId: n.id, session });
  say(`做完了，存成了笔记「${title}」`, { label: "打开", run: () => useUi.getState().openPeek(n.id) });
}

/** 导出上下文 */
export async function exportContext(itemId: string) {
  const it = itemOf(itemId);
  if (!it) return;
  try {
    const r = await buildContextZip(it, allItems());
    const path = await saveFile(r.name, r.zip);
    const what = `这一条${r.related ? `、关联的 ${r.related} 条` : ""}${r.files ? `、${r.files} 个附件` : ""}`;
    say(`已导出上下文（${what}）${path ? "：" + path : ""}${r.missing.length ? `；有 ${r.missing.length} 个附件没取到` : ""}`, path ? { label: "打开文件夹", run: () => openTarget(path.replace(/[\\/][^\\/]*$/, "")) } : undefined);
  } catch (e) {
    say("导出失败：" + errText(e));
  }
}

/* ---------------------------------------------------------------- 「交给 AI」先选怎么交 */

/** 点「交给 AI」先到这里：先和我讨论（默认），或者直接开工（onDirect 打开原来的窗口） */
export function openHandoff(it: Item, onDirect: () => void) {
  openDialog((close) => <Handoff it={it} close={close} onDirect={onDirect} />);
}

function Handoff({ it, close, onDirect }: { it: Item; close: () => void; onDirect: () => void }) {
  const agents = (useConfig().data?.config.agents ?? []).filter(canAsk);
  const me = useThisDevice();
  const [pick, setPick] = useState(() => Math.max(0, agents.findIndex((a) => a.name === ls.get("wb-agent"))));
  const has = !!briefOf(it);
  const manual = !isApp || !agents.length;
  const start = async () => {
    close();
    if (manual) {
      // 手动：先建一个空的讨论，面板里给提示词
      await saveBrief(it, { agent: MANUAL, status: "asking", startedAt: Date.now(), rounds: [] });
    } else {
      const a = agents[pick];
      ls.set("wb-agent", a.name);
      await saveBrief(it, { agent: a.name, status: "asking", startedAt: Date.now(), rounds: [] });
      runRound(it.id, a, me);
    }
    useUi.getState().openPeek(it.id);
  };
  return (
    <Dialog
      title="交给 AI"
      desc={`「${noteTitle(it)}」`}
      onClose={close}
      footer={
        <>
          <Button tone="primary" onClick={has ? () => (close(), useUi.getState().openPeek(it.id)) : start}>
            <Bot className="size-4" />
            {has ? "接着讨论" : "先和我讨论"}
          </Button>
          <Button onClick={() => (close(), onDirect())}>
            <SquareTerminal className="size-4" />
            {isApp ? "直接开工（开终端）" : "直接复制提示词"}
          </Button>
          <span className="grow" />
          <Button tone="ghost" onClick={() => exportContext(it.id)} title="这一条、关联的条目和附件打成一个压缩包">
            <FileDown className="size-4" />
            导出上下文
          </Button>
        </>
      }
    >
      <p className="text-[13.5px] leading-relaxed text-fg-2">
        <b className="font-semibold text-fg">先和我讨论</b>：事情还没想清楚也可以交。AI 先看这一条、关联的条目和附件，然后问你几个问题（要什么样的产出、放在哪、用哪些现成的材料，以及这件事本身不清楚的地方）。
        你在这一条下面回答，它出一个计划，你点了开始它才动手。
      </p>
      {has ? (
        <p className="text-[13px] text-muted">这一条已经在讨论了，点「接着讨论」回去看。</p>
      ) : manual ? (
        <p className="rounded-xl bg-surface-2 px-3.5 py-2.5 text-[13px] leading-relaxed text-muted">
          {isApp ? "还没有配置能在后台回答的 AI（设置里加 Claude Code 或 Codex）。" : "网页版叫不动电脑上的 AI。"}会走手动：把提示词复制给任意一个 AI，再把它的回复贴回来。
        </p>
      ) : (
        <Pick label="和哪个 AI 讨论" items={agents} value={pick} onChange={setPick} render={(a) => (<><Sparkles />{a.name}</>)} />
      )}
    </Dialog>
  );
}

/* ---------------------------------------------------------------- 这一条下面的讨论面板 */

function Question({ q, n, value, onChange, onBlur }: { q: BriefQ; n: number; value: string; onChange: (v: string) => void; onBlur: () => void }) {
  const picked = (o: string) => value.split(/[；;\n]/).map((x) => x.trim()).includes(o);
  const toggle = (o: string) => {
    const parts = value.split(/[；;\n]/).map((x) => x.trim()).filter(Boolean);
    onChange((picked(o) ? parts.filter((x) => x !== o) : [...parts, o]).join("；"));
  };
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[13.5px] leading-relaxed text-fg">
        <span className="mr-1.5 text-muted">{n}.</span>
        {q.q}
        {q.why && <span className="ml-1.5 text-xs text-faint">{q.why}</span>}
      </div>
      {!!q.options?.length && (
        <div className="flex flex-wrap gap-1.5">
          {q.options.map((o) => (
            <button key={o} aria-pressed={picked(o)} onClick={() => (toggle(o), window.setTimeout(onBlur, 0))} className={cx("rounded-lg px-2.5 py-1 text-left text-[12.5px] transition-colors", picked(o) ? "bg-ink text-on-ink" : "bg-surface text-fg-2 hover:bg-surface-3")}>
              {o}
            </button>
          ))}
        </div>
      )}
      <textarea
        className={cx(textareaCls, "min-h-[38px] bg-surface")}
        rows={1}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        placeholder={q.options?.length ? "点上面的选项，或者直接写；可以补充" : "写你的回答；不想答可以空着，它会自己定"}
        aria-label={"回答：" + q.q}
      />
    </div>
  );
}

export function BriefPanel({ it }: { it: Item }) {
  const b = briefOf(it);
  const me = useThisDevice();
  const agents = useConfig().data?.config.agents ?? [];
  const busy = useBriefRun((s) => s.busy[it.id]);
  const err = useBriefRun((s) => s.err[it.id]);
  const last = b?.rounds[b.rounds.length - 1];
  const [ans, setAns] = useState<Record<string, string>>({});
  const [fb, setFb] = useState("");
  const [paste, setPaste] = useState("");
  const [old, setOld] = useState(false);
  /** 做完之后让它接着改的意见 */
  const [more, setMore] = useState("");
  const ansRef = useRef(ans);
  ansRef.current = ans;
  // 换了一轮问题：把已经存下的回答读进来
  useEffect(() => {
    setAns(Object.fromEntries((last?.questions ?? []).map((q) => [q.id, q.a ?? ""])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [it.id, last?.at]);
  if (!b) return null;

  const agent = agents.find((a) => a.name === b.agent && canAsk(a));
  const manual = !isApp || !agent;
  /** 把正在填的回答存进条目（离开输入框时、发给 AI 之前） */
  const persist = async () => {
    const cur = itemOf(it.id);
    const cb = briefOf(cur);
    if (!cur || !cb || !cb.rounds.length) return cb;
    const rounds = cb.rounds.slice();
    const r = rounds[rounds.length - 1];
    const qs = r.questions.map((q) => ({ ...q, a: (ansRef.current[q.id] ?? q.a ?? "").trim() || undefined }));
    if (JSON.stringify(qs) === JSON.stringify(r.questions)) return cb;
    rounds[rounds.length - 1] = { ...r, questions: qs };
    const next = { ...cb, rounds };
    await saveBrief(cur, next);
    return next;
  };
  const send = async (force = false) => {
    await persist();
    if (agent && !manual) runRound(it.id, agent, me, force);
  };
  const revise = async () => {
    const cur = itemOf(it.id);
    const cb = briefOf(cur);
    if (!cur || !cb || !fb.trim()) return;
    await saveBrief(cur, { ...cb, feedback: [...(cb.feedback ?? []), fb.trim()] });
    setFb("");
    if (agent && !manual) runRound(it.id, agent, me);
  };
  /** 手动：现在该复制哪段提示词 */
  const prompt = () => {
    const cur = itemOf(it.id) ?? it;
    const cb = briefOf(cur);
    const { rel } = material(cur);
    return cb?.status === "ready" ? buildWorkPrompt(cur, cb, rel) : buildBriefPrompt(cur, cb, rel);
  };
  const readPaste = async () => {
    const cur = itemOf(it.id);
    if (!cur || !paste.trim()) return;
    setErr(it.id, "");
    try {
      if (briefOf(cur)?.status === "ready") await saveResult(it.id, paste);
      else await saveBrief(cur, applyReply(briefOf(cur), b.agent, parseBrief(paste)));
      setPaste("");
    } catch (e) {
      setErr(it.id, errText(e));
    }
  };
  const result = b.resultId ? itemOf(b.resultId) : undefined;
  const unanswered = (last?.questions ?? []).filter((q) => !(ans[q.id] ?? "").trim()).length;
  const waitingFirst = b.status === "asking" && !b.rounds.length;
  const head = busy ? busy : b.status === "done" ? "做完了" : b.status === "ready" ? "出了计划，等你确认" : waitingFirst ? (manual ? "把提示词交给 AI，再把回复贴回来" : "还没问成") : `第 ${b.rounds.length} 轮 · 等你回答`;

  return (
    <section aria-label="和 AI 讨论" className="flex flex-col gap-3 rounded-2xl bg-surface-2 p-4">
      <div className="flex items-center gap-2">
        <Bot className="size-[18px] shrink-0 text-accent" strokeWidth={1.8} />
        <h3 className="min-w-0 truncate text-[14px] font-semibold">和 {b.agent === MANUAL ? "AI" : b.agent} 讨论</h3>
        <Chip tone={busy ? "plain" : b.status === "done" ? "plain" : "accent"} className="min-w-0 shrink truncate">
          {head}
        </Chip>
        <span className="grow" />
        <Button tone="ghost" className="h-7 px-2 text-xs" onClick={() => exportContext(it.id)} title="这一条、讨论、关联的条目和附件打成一个压缩包">
          <FileDown className="size-3.5" />
          导出
        </Button>
        <ConfirmButton tone="ghost" className="h-7 px-2 text-xs" confirm="再点一次删掉" onConfirm={() => saveBrief(itemOf(it.id) ?? it, null)}>
          <X className="size-3.5" />
          结束
        </ConfirmButton>
      </div>

      {b.rounds.length > (b.status === "asking" ? 1 : 0) && (
        <div className="flex flex-col gap-2">
          <button className="flex items-center gap-1 self-start text-xs text-muted hover:text-fg" onClick={() => setOld(!old)} aria-expanded={old}>
            <ChevronDown className={cx("size-3.5 transition-transform", !old && "-rotate-90")} />
            {b.status === "asking" ? `前 ${b.rounds.length - 1} 轮的问答` : `问答记录（${b.rounds.length} 轮）`}
          </button>
          {old &&
            (b.status === "asking" ? b.rounds.slice(0, -1) : b.rounds).map((r, i) => (
              <div key={r.at} className="flex flex-col gap-1.5 rounded-xl bg-surface px-3.5 py-2.5 text-[13px]">
                <span className="text-xs text-faint">
                  第 {i + 1} 轮 · {ago(r.at)}
                </span>
                {r.questions.map((q) => (
                  <div key={q.id} className="flex flex-col">
                    <span className="text-muted">{q.q}</span>
                    <span className="whitespace-pre-wrap text-fg">{q.a || "（没回答）"}</span>
                  </div>
                ))}
              </div>
            ))}
        </div>
      )}

      {b.status === "asking" && last && !busy && (
        <>
          {last.note && <p className="text-[13px] leading-relaxed text-muted">它的理解：{last.note}</p>}
          <div className="flex flex-col gap-3.5">
            {last.questions.map((q, i) => (
              <Question key={q.id} q={q} n={i + 1} value={ans[q.id] ?? ""} onChange={(v) => setAns((a) => ({ ...a, [q.id]: v }))} onBlur={persist} />
            ))}
          </div>
          {!manual && (
            <div className="flex flex-wrap items-center gap-2">
              <Button tone="primary" onClick={() => send()}>
                <Send className="size-4" />
                回答好了，发给 {b.agent}
              </Button>
              <Button onClick={() => send(true)} title="不再提问，按现在知道的出计划">
                别问了，直接出计划
              </Button>
              {unanswered > 0 && <span className="text-xs text-faint">还有 {unanswered} 个没答，空着的它自己定</span>}
            </div>
          )}
        </>
      )}

      {b.status === "ready" && b.plan && !busy && (
        <>
          <div className="rounded-xl bg-surface px-4 py-3 text-[13.5px]">
            <Md src={b.plan} />
          </div>
          {!manual && (
            <div className="flex flex-wrap items-center gap-2">
              <Button tone="primary" onClick={() => agent && runWork(it.id, agent, me)}>
                <Play className="size-4" />
                开始做，产出存成笔记
              </Button>
              <Button onClick={() => import("../dialogs/Agent").then((m) => m.openAgent(itemOf(it.id) ?? it, `${buildPrompt(it)}\n\n我们已经讨论过怎么做，下面是讨论记录和定下来的计划，照这个做：\n\n${briefDigest(b)}`))} title="要改代码、动文件的事：开一个终端，把讨论的结果交给它">
                <SquareTerminal className="size-4" />
                到终端里做
              </Button>
            </div>
          )}
          <div className="flex items-end gap-2">
            <textarea className={cx(textareaCls, "min-h-[38px] grow bg-surface")} rows={1} value={fb} onChange={(e) => setFb(e.target.value)} placeholder="计划哪里不对？写在这里让它改" aria-label="对计划的意见" />
            <Button disabled={!fb.trim()} onClick={revise}>
              {manual ? "记下意见" : "让它改"}
            </Button>
          </div>
        </>
      )}

      {b.status === "done" && !busy && (
        <div className="flex flex-wrap items-center gap-2 text-[13.5px]">
          {result ? (
            <>
              <span className="text-fg-2">产出：</span>
              <Button className="bg-surface hover:bg-surface-3" onClick={() => useUi.getState().openPeek(result.id)}>
                {noteTitle(result)}
              </Button>
            </>
          ) : (
            <span className="text-muted">产出的笔记已经不在了。</span>
          )}
          <span className="grow" />
          {!manual && (
            <Button tone="ghost" onClick={() => agent && runWork(it.id, agent, me)} title="按同样的计划从头再做一遍，另存一篇">
              <RotateCw className="size-4" />
              从头再做
            </Button>
          )}
        </div>
      )}
      {b.status === "done" && !busy && (b.revisions?.length ?? 0) > 0 && (
        <ul className="flex flex-col gap-1 text-[12.5px] text-muted">
          {b.revisions!.map((r) => (
            <li key={r.at} className="flex gap-2">
              <span className="shrink-0 text-faint">{ago(r.at)}让它改：</span>
              <span className="min-w-0 break-words whitespace-pre-wrap">{r.note}</span>
            </li>
          ))}
        </ul>
      )}
      {b.status === "done" && !busy && !manual && (
        <div className="flex items-end gap-2">
          <textarea
            className={cx(textareaCls, "min-h-[38px] grow bg-surface")}
            rows={Math.min(6, more.split("\n").length)}
            value={more}
            onChange={(e) => setMore(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && more.trim() && agent) {
                e.preventDefault();
                runRevise(it.id, agent, me, more);
                setMore("");
              }
            }}
            placeholder="不满意？告诉它接着怎么改，Ctrl+回车发送"
            aria-label="接着改的意见"
          />
          <Button
            tone="primary"
            disabled={!more.trim() || !agent}
            onClick={() => {
              if (!agent) return;
              runRevise(it.id, agent, me, more);
              setMore("");
            }}
            title={b.session ? "接着上一次的对话改，它记得自己做过什么" : "把讨论、计划和上一版一起给它，让它改"}
          >
            <Send className="size-4" />
            接着改
          </Button>
        </div>
      )}

      {busy && <AiLive itemId={it.id} />}

      {waitingFirst && !busy && !manual && (
        <Button className="self-start" onClick={() => agent && runRound(it.id, agent, me)}>
          <RotateCw className="size-4" />
          重新让 {b.agent} 提问
        </Button>
      )}

      {manual && b.status !== "done" && (
        <div className="flex flex-col gap-2 rounded-xl bg-surface px-3.5 py-3">
          <span className="text-xs leading-relaxed text-muted">
            {isApp ? `没找到能在后台回答的「${b.agent}」，` : "网页版叫不动电脑上的 AI，"}这里走手动：{b.status === "ready" ? "复制开工的提示词交给 AI，把它写的成品贴回来存成笔记。" : b.rounds.length ? "回答完上面的问题后，复制提示词交给 AI，把它的回复贴回来。" : "复制提示词交给任意一个 AI，把它的回复贴回来。"}
          </span>
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={async () => {
                await persist();
                say((await copyText(prompt())) ? "已复制提示词，贴给 AI" : "复制失败");
              }}
            >
              <Copy className="size-4" />
              复制{b.status === "ready" ? "开工的" : ""}提示词
            </Button>
          </div>
          <textarea className={cx(textareaCls, "min-h-[64px] font-mono text-[12.5px]")} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="把 AI 的回复整段贴到这里" aria-label="AI 的回复" />
          <Button className="self-start" disabled={!paste.trim()} onClick={readPaste}>
            <ClipboardPaste className="size-4" />
            {b.status === "ready" ? "存成笔记" : "读入回复"}
          </Button>
        </div>
      )}
      {err && <div className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap text-danger">{err}</div>}
    </section>
  );
}
