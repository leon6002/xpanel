/* 问 AI：选中的原文 + 问题 → 本机 Claude Code / Codex 在后台回答（claude -p），答案挂在原文旁边。
   浏览器里调不了本机 AI：复制提问发给任意 AI，再把回答贴回来。 */
import { Copy, Sparkles } from "lucide-react";
import { useState } from "react";
import { copyText, desk, errText, isApp, newId } from "../lib/api";
import { patchItem, qc, useConfig, useThisDevice } from "../lib/data";
import { Dialog, openDialog } from "../lib/dialog";
import { buildAskPrompt, type QaSel } from "../lib/qa";
import { ls, useUi } from "../lib/store";
import type { Agent, Item, Qa, State } from "../lib/types";
import { myWorkspace } from "../lib/ws";
import { Md } from "../components/Markdown";
import { Button, ErrorText, Field, Pick, textareaCls } from "../components/ui";

const say = (t: string) => useUi.getState().say(t);
const itemOf = (id: string) => qc.getQueryData<State>(["state"])?.items.find((x) => x.id === id);

/** 能直接问答的 AI：填了问答命令，或者是 claude / codex（自动用 -p / exec -） */
export const askAgents = (agents: Agent[]) =>
  agents.filter((a) => (a.ask || "").trim() || /^(claude|codex)(\.exe|\.cmd)?\b/i.test(String(a.cmd || "").trim().split(/[\\/]/).pop() || ""));

type Ctx = Omit<QaSel, "itemId"> & { itemId: string; draft?: string; error?: string };

export function openAsk(ctx: Ctx, followId?: string) {
  openDialog((close) => <AskDialog ctx={ctx} followId={followId} close={close} />);
}

async function saveQa(itemId: string, ctx: Ctx, followId: string | undefined, q: string, a: string, by: string) {
  const cur = itemOf(itemId);
  if (!cur) return;
  const list: Qa[] = (cur.qa || []).slice();
  const turn = { q, a, at: Date.now(), by };
  if (followId) {
    const i = list.findIndex((x) => x.id === followId);
    if (i >= 0) list[i] = { ...list[i], turns: [...(list[i].turns || []), turn] };
  } else list.push({ id: newId(), quote: ctx.quote || "", prefix: ctx.prefix || "", suffix: ctx.suffix || "", at: Date.now(), turns: [turn] });
  await patchItem(cur, { qa: list });
}

function AskDialog({ ctx, followId, close }: { ctx: Ctx; followId?: string; close: () => void }) {
  const it = itemOf(ctx.itemId) as Item;
  const cfg = useConfig().data?.config;
  const me = useThisDevice();
  const agents = askAgents(cfg?.agents ?? []);
  const [pick, setPick] = useState(() => Math.max(0, agents.findIndex((a) => a.name === ls.get("wb-askagent"))));
  const q0 = followId ? (it?.qa || []).find((q) => q.id === followId) : undefined;
  const quote = q0 ? q0.quote : ctx.quote;
  const [q, setQ] = useState(ctx.draft || "");
  const [ans, setAns] = useState("");
  const [err, setErr] = useState(ctx.error || "");
  if (!it) return null;
  const prev = q0?.turns;
  const ws = isApp ? myWorkspace(it, me) : null;

  async function ask() {
    const question = q.trim();
    if (!question) return;
    const a = agents[pick];
    ls.set("wb-askagent", a.name);
    close();
    window.getSelection()?.removeAllRanges();
    const p = { q: question, quote, agent: a.name };
    const add = (fn: (l: (typeof p)[]) => (typeof p)[]) =>
      useUi.setState((s) => ({ qaPending: { ...s.qaPending, [it.id]: fn(s.qaPending[it.id] || []) } }));
    add((l) => [...l, p]);
    try {
      const answer = await desk.askAi(a, ws ? ws.path : "", buildAskPrompt(it, { ...ctx, quote }, question, prev));
      add((l) => l.filter((x) => x !== p));
      await saveQa(it.id, ctx, followId, question, String(answer).trim(), a.name);
      say(`${a.name} 回答了，已挂在原文旁边`);
    } catch (e) {
      add((l) => l.filter((x) => x !== p));
      openAsk({ ...ctx, draft: question, error: "没问成：" + errText(e) }, followId);
    }
  }

  return (
    <Dialog
      title={q0 ? "追问" : "问 AI"}
      onClose={close}
      footer={
        <>
          {isApp ? (
            <Button tone="primary" disabled={!agents.length || !q.trim()} onClick={ask}>
              <Sparkles className="size-4" />
              提问
            </Button>
          ) : (
            <Button
              tone="primary"
              onClick={async () => {
                if (!q.trim() || !ans.trim()) return setErr("问题和回答都要填");
                close();
                await saveQa(it.id, ctx, followId, q.trim(), ans.trim(), "手动").catch(() => {});
                say("问答已保存");
              }}
            >
              保存问答
            </Button>
          )}
          <span className="grow" />
          <Button
            onClick={async () => {
              if (!q.trim()) return;
              say((await copyText(buildAskPrompt(it, { ...ctx, quote }, q.trim(), prev))) ? "已复制，发给任意 AI 即可" : "复制失败");
            }}
          >
            <Copy className="size-4" />
            复制提问
          </Button>
        </>
      }
    >
      <blockquote className="max-h-32 overflow-y-auto rounded-lg border-l-[3px] border-mark-fg/40 bg-mark px-3 py-2 text-[13px] whitespace-pre-wrap text-mark-fg">
        {quote || `针对整篇笔记「${it.title || ""}」`}
      </blockquote>
      {prev?.map((t, i) => (
        <div key={i} className="flex flex-col gap-1 rounded-lg bg-surface-2 px-3 py-2">
          <div className="text-[13px] font-semibold">{t.q}</div>
          <Md src={t.a} className="!text-[13px]" />
        </div>
      ))}
      <Field label="问题">
        <textarea
          autoFocus
          className={textareaCls + " min-h-[90px]"}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.ctrlKey || e.metaKey) && isApp && ask()}
          placeholder="比如：这里说的分层分别负责什么？和我们项目的对应关系是？"
        />
      </Field>
      {isApp ? (
        agents.length ? (
          <>
            <Pick label="问哪个 AI" items={agents} value={pick} onChange={setPick} render={(a) => (<><Sparkles />{a.name}</>)} />
            <p className="text-xs text-muted">{ws ? "会在这条笔记的项目目录里提问，AI 能看到里面的截图和材料。" : "不开窗口，在后台问，答完自动挂到原文旁边。"}</p>
          </>
        ) : (
          <ErrorText>还没有能直接问答的 AI。去「设置」给 AI 填一个问答命令（比如 claude -p）。</ErrorText>
        )
      ) : (
        <>
          <p className="text-xs text-muted">网页版不能直接调用本机的 AI：先「复制提问」发给任意 AI，再把回答粘到下面。</p>
          <Field label="回答">
            <textarea className={textareaCls + " min-h-[120px]"} value={ans} onChange={(e) => setAns(e.target.value)} placeholder="把 AI 的回答粘贴到这里" />
          </Field>
        </>
      )}
      <ErrorText>{err}</ErrorText>
    </Dialog>
  );
}
