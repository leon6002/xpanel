/* 后台的 AI 正在做什么：
   AiLive —— 放在等它回答的地方（讨论面板、评论），实时列出它走的每一步，可以停止；
   AiPermits —— 它要运行命令、读写工作目录外的文件时弹出来让你点头（整个界面挂一个）。
   只有桌面版叫 Claude Code 时有这些；别的 AI 只显示在跑和多久了。 */
import { CircleStop, FileText, Globe, MessageSquare, Search, SquareTerminal, TriangleAlert, Wrench } from "lucide-react";
import { useEffect, useState } from "react";
import { decideAi, stopAi, useAiRuns, type AiDecision, type AiRun, type AiStep } from "../lib/aiRuns";
import { errText } from "../lib/api";
import { cx } from "../lib/cx";
import { useAppState } from "../lib/data";
import { Dialog } from "../lib/dialog";
import { noteTitle } from "../lib/logic";
import { useUi } from "../lib/store";
import { Button } from "./ui";

function useNow(on: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [on]);
  return now;
}
const span = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
};

function StepIcon({ s }: { s: AiStep }) {
  const cls = "mt-[3px] size-3.5 shrink-0";
  if (s.kind === "error") return <TriangleAlert className={cx(cls, "text-danger")} />;
  if (s.kind === "text") return <MessageSquare className={cx(cls, "text-faint")} />;
  if (s.label.includes("命令")) return <SquareTerminal className={cx(cls, "text-muted")} />;
  if (s.label.includes("网页")) return <Globe className={cx(cls, "text-muted")} />;
  if (s.label.includes("找") || s.label.includes("搜") || s.label.includes("查")) return <Search className={cx(cls, "text-muted")} />;
  if (s.label.includes("文件")) return <FileText className={cx(cls, "text-muted")} />;
  return <Wrench className={cx(cls, "text-muted")} />;
}

function Step({ s }: { s: AiStep }) {
  return (
    <li className="flex min-w-0 items-start gap-2 text-[12.5px] leading-[1.5]">
      <StepIcon s={s} />
      {s.kind === "tool" ? (
        <span className="min-w-0 truncate" title={s.text}>
          <span className="text-fg-2">{s.label}</span>
          {s.text && <span className="ml-1.5 font-mono text-[12px] text-muted">{s.text}</span>}
        </span>
      ) : (
        <span className={cx("line-clamp-2 min-w-0 break-words", s.kind === "error" ? "text-danger" : "text-muted")} title={s.text}>
          {s.label && <span className="mr-1.5">{s.label}</span>}
          {s.text}
        </span>
      )}
    </li>
  );
}

function RunView({ run }: { run: AiRun }) {
  const now = useNow(true);
  const [all, setAll] = useState(false);
  const shown = all ? run.steps : run.steps.slice(-5);
  const tools = run.steps.filter((s) => s.kind === "tool").length;
  return (
    <section aria-label={run.agent + " 的进展"} className="flex min-w-0 flex-col gap-1.5 rounded-xl bg-surface-2 px-3 py-2.5">
      <div className="flex items-center gap-2 text-xs text-muted">
        <span className={cx("size-2 shrink-0 rounded-full", run.ask ? "bg-accent" : "animate-pulse bg-accent")} />
        <span className="min-w-0 truncate">
          <b className="font-semibold text-fg-2">{run.agent}</b> {run.stopping ? "正在停止…" : run.ask ? "在等你确认" : "在做"} · {span(now - run.at)}
          {tools > 0 && ` · ${tools} 步`}
        </span>
        <span className="grow" />
        {run.steps.length > 5 && (
          <button className="shrink-0 rounded-md px-1.5 py-0.5 hover:bg-surface-3 hover:text-fg" onClick={() => setAll(!all)}>
            {all ? "只看最近的" : `前面还有 ${run.steps.length - 5} 步`}
          </button>
        )}
        <button
          className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-surface-3 hover:text-fg disabled:opacity-50 [&_svg]:size-3.5"
          disabled={run.stopping}
          onClick={() => stopAi(run).catch((e) => useUi.getState().say(errText(e)))}
          title="让它停下，这一次不要结果了"
        >
          <CircleStop /> 停止
        </button>
      </div>
      {shown.length > 0 ? (
        <ol className={cx("flex min-w-0 flex-col gap-1", all && "scroll-quiet max-h-64 overflow-y-auto")}>
          {shown.map((s, i) => (
            <Step key={s.at + "-" + i} s={s} />
          ))}
        </ol>
      ) : (
        <p className="text-xs text-faint">还没有动静，刚开始要等一会儿。可以先去做别的，好了会提醒你。</p>
      )}
      {run.ask && (
        <p className="text-[12.5px] text-accent-strong">
          等你确认：{run.ask.what} <span className="font-mono text-[12px]">{run.ask.detail}</span>
        </p>
      )}
    </section>
  );
}

/** 这一条（和这一串评论）上正在跑的 AI */
export function AiLive({ itemId, tag }: { itemId: string; tag?: string }) {
  const runs = useAiRuns((s) => s.runs);
  const mine = Object.values(runs).filter((r) => r.key === itemId && (tag === undefined || r.tag === tag));
  if (!mine.length) return null;
  return (
    <>
      {mine.map((r) => (
        <RunView key={r.id} run={r} />
      ))}
    </>
  );
}

function PermitDialog({ run, more }: { run: AiRun; more: number }) {
  const ask = run.ask!;
  const items = useAppState().data?.items ?? [];
  const it = items.find((i) => i.id === run.key);
  // 刚弹出来的一小会儿不让点：免得正在别处敲回车、点鼠标时顺手就同意了
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setArmed(true), 500);
    return () => window.clearTimeout(t);
  }, []);
  const answer = (d: AiDecision) => decideAi(run, d).catch((e) => useUi.getState().say(errText(e)));
  return (
    <Dialog
      title={`${run.agent} 想${ask.what}`}
      desc={(it ? `在做「${noteTitle(it)}」。` : "") + (run.remote ? "它在主机上做的事，要你点头才会做。" : "它在这台电脑上做的事，要你点头才会做。")}
      onClose={() => {}}
      dismissable={false}
      wide
      footer={
        <>
          <Button tone="primary" disabled={!armed} onClick={() => answer("allow")}>
            允许这一次
          </Button>
          {ask.kind && ask.kind !== "这一条命令" && (
            <Button disabled={!armed} onClick={() => answer("kind")} title="这次任务里，同类的不再问">
              以后{ask.kind}都允许
            </Button>
          )}
          <Button disabled={!armed} onClick={() => answer("all")} title="这次任务里什么都不再问，直到它做完">
            这次任务都允许
          </Button>
          <span className="grow" />
          {more > 0 && <span className="text-xs text-faint">后面还有 {more} 个</span>}
          <Button tone="ghost" onClick={() => answer("deny")}>
            拒绝
          </Button>
        </>
      }
    >
      <pre className="scroll-quiet max-h-[40vh] overflow-auto rounded-xl bg-surface-2 px-3.5 py-3 font-mono text-[13px] leading-relaxed break-all whitespace-pre-wrap text-fg select-text">{ask.detail || ask.tool}</pre>
      <p className="text-xs leading-relaxed text-faint">「都允许」只管这一次任务，做完就失效。拒绝后它会换个办法或者跳过这一步；想让它整个停下，在进展那里点「停止」。</p>
    </Dialog>
  );
}

/** 整个界面挂一个：有 AI 在等你点头就弹出来 */
export function AiPermits() {
  const runs = useAiRuns((s) => s.runs);
  const waiting = Object.values(runs)
    .filter((r) => r.ask)
    .sort((a, b) => a.at - b.at);
  const r = waiting[0];
  if (!r?.ask) return null;
  return <PermitDialog key={r.id + ":" + r.ask.id} run={r} more={waiting.length - 1} />;
}
