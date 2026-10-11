/* 交给 AI 之前先讨论：AI 看完这一条和关联的材料，先提问（产出是什么、放哪、用哪些现成的材料，以及这件事本身不清楚的地方），
   你在面板里回答，可以来回几轮；它给出计划，你点了开始它才动手。讨论记在条目的 brief 字段里，跟着条目同步。
   AI 的回复是一个 JSON（见 buildBriefPrompt 里的格式），解析在 parseBrief。 */
import { newId } from "./api";
import { contextLines } from "./qa";
import type { Item } from "./types";
import { typeName } from "./types";

export interface BriefQ { id: string; q: string; why?: string; options?: string[]; a?: string }
/** 一轮：AI 问的几个问题（和你的回答）；feedback 是你对上一版计划的意见 */
export interface BriefRound { at: number; note?: string; questions: BriefQ[] }
export interface Brief {
  agent: string;
  /** asking = 等你回答；ready = 出了计划，等你点开始；done = 做完了 */
  status: "asking" | "ready" | "done";
  startedAt: number;
  rounds: BriefRound[];
  plan?: string;
  /** 你对计划的意见（让它改的时候写的） */
  feedback?: string[];
  /** 产出存成的笔记 */
  resultId?: string;
}
export const briefOf = (it?: Item | null) => (it?.brief as Brief | undefined) || undefined;
/** 还没回答的问题（最新一轮） */
export const openQuestions = (b?: Brief) => (b?.status === "asking" ? (b.rounds[b.rounds.length - 1]?.questions ?? []).filter((q) => !(q.a || "").trim()) : []);

type Rel = { item: Item; label?: string }[];
const history = (b: Brief | undefined) => {
  const L: string[] = [];
  const asked = (b?.rounds ?? []).flatMap((r) => r.questions);
  if (asked.length) {
    L.push(``, `你已经问过、我已经回答的：`);
    asked.forEach((q, i) => L.push(`${i + 1}. 问：${q.q}`, `   答：${(q.a || "").trim() || "（我没有回答，你按常理自己定）"}`));
  }
  if (b?.plan) L.push(``, `你上一版的计划：`, b.plan);
  if (b?.feedback?.length) L.push(``, `我对计划的意见（按这个改）：`, ...b.feedback.map((f) => "- " + f));
  return L;
};

/** 讨论阶段的提示词。force：别再问了，直接给计划 */
/** 桌面版叫本机的 Claude Code 时会把 xpanel 的 MCP 一起接上（src-tauri 的 with_mcp）；别的 AI、手动复制提示词时不一定有，所以写成「有就用」 */
const TOOLS = `关于工作台（xpanel）本身：你的工具里如果有名字以 mcp__xpanel__ 开头的，就能直接读写工作台——查条目（xpanel_list_items、xpanel_get_item）、新建事项 / 笔记 / 入口（xpanel_create_items）、改条目（xpanel_update_item）。`;

export function buildBriefPrompt(it: Item, b: Brief | undefined, related: Rel, force = false) {
  const L = [
    `你在帮我做工作台里的一件事（一条「${typeName(it.type)}」）。现在是「先讨论」阶段：不要开始做，不要改任何文件，只弄清楚我要什么。`,
    ``,
    ...contextLines(it, related),
    ...history(b),
    ``,
    TOOLS,
    `所以「怎么写进工作台」不用问我，也不要去找工作台的配置文件。讨论阶段只许用这些工具查，不要新建或修改。开工后你最后的回答会自动存成一篇笔记并关联到这条，所以计划里的笔记不用工具建，别的条目（入口、事项）才用工具建。没有这些工具时，在计划里写明哪些条目要我自己加。`,
    ``,
  ];
  if (force) L.push(`不要再提问了。按现在知道的给出计划，拿不准的地方在计划里写明你打算怎么处理。`);
  else
    L.push(
      `你的任务：判断要把这件事做好还需要向我确认什么，只问最必要的问题。`,
      `- 问题要针对这件事本身，具体，一个问题只问一件事。能从上面的材料里读出来的不要问；我回答过的不要再问。`,
      `- 这三件事必须弄清楚（材料或回答里已经有了就不用问）：产出是什么形式；产出放在哪里（工作台里的一篇笔记，还是电脑上的某个文件夹）；有哪些现成的材料可以用、还缺什么需要我给你。`,
      `- 一轮最多 6 个问题。能列出选项的给 2 到 4 个简短的选项，方便我直接点。`,
      `- 一般问一到两轮就够。信息够了就不要再问，给出计划。`,
    );
  L.push(
    `计划要短：分几步做、产出是什么、放在哪、会用到哪些材料、哪些你做不了或者需要我之后补。`,
    ``,
    `只输出一个 JSON，前后不要有任何别的文字：`,
    force ? `` : `还要问时：{"ready": false, "note": "一句话说你现在的理解", "questions": [{"id": "q1", "q": "问题", "why": "为什么要问，一句话，可以省略", "options": ["选项一", "选项二"]}]}`,
    `可以开工时：{"ready": true, "plan": "计划，Markdown 格式"}`,
  );
  return L.filter((x, i, a) => !(x === "" && a[i - 1] === "")).join("\n");
}

/** 开工的提示词：产出一篇 Markdown，存成笔记 */
export function buildWorkPrompt(it: Item, b: Brief, related: Rel) {
  return [
    `你在帮我做工作台里的一件事（一条「${typeName(it.type)}」）。我们已经讨论清楚了，现在开始做。`,
    ``,
    ...contextLines(it, related),
    ...history({ ...b, feedback: undefined }),
    ``,
    `按上面的计划把它做出来。产出会原样存成工作台里的一篇笔记，所以：`,
    `- 直接输出成品，Markdown 格式，第一行是一级标题（# 开头）当笔记的标题。不要写「好的」「以下是」这类开场白，也不要再提问。`,
    `- 计划里说要放到某个文件夹的，你现在改不了文件：照样把内容写在这篇笔记里，并在最后用一小节「接下来」说明要放到哪、怎么放。`,
    `- 你做不了、需要我补的，也写进「接下来」。`,
    ``,
    TOOLS,
    `- 计划里除了这篇笔记之外还要加的条目（比如常用入口、事项），有这些工具就直接建好，并在笔记里列出建了哪些；入口的 type 是 link，正文第一行写网址或路径。没有这些工具时，把要加的条目列在「接下来」里。`,
    `- 这篇笔记本身不要用工具建：直接输出，会自动存好并关联到这条。`,
  ].join("\n");
}

/** 从 AI 的回复里取出那个 JSON（它有时会包一层 ```json，或者前后带几句话） */
export function parseBrief(text: string): { ready: false; note?: string; questions: BriefQ[] } | { ready: true; plan: string } {
  const raw = String(text || "").trim();
  const tryParse = (s: string) => {
    try {
      return JSON.parse(s) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1];
  const a = raw.indexOf("{");
  const z = raw.lastIndexOf("}");
  const v = tryParse(raw) ?? (fenced ? tryParse(fenced.trim()) : null) ?? (a >= 0 && z > a ? tryParse(raw.slice(a, z + 1)) : null);
  if (!v) throw new Error("AI 的回复不是约定的格式，看不懂。可以再试一次");
  if (v.ready === true || (typeof v.plan === "string" && !Array.isArray(v.questions))) {
    const plan = String(v.plan || "").trim();
    if (!plan) throw new Error("AI 说可以开工了，但没有给计划。可以再试一次");
    return { ready: true, plan };
  }
  const qs = (Array.isArray(v.questions) ? v.questions : [])
    .map((x): BriefQ | null => {
      const o = (typeof x === "string" ? { q: x } : x) as Record<string, unknown>;
      const q = String(o?.q ?? o?.question ?? "").trim();
      if (!q) return null;
      const options = Array.isArray(o.options) ? o.options.map((s) => String(s).trim()).filter(Boolean).slice(0, 6) : [];
      return { id: newId(), q, ...(String(o.why || "").trim() ? { why: String(o.why).trim() } : {}), ...(options.length ? { options } : {}) };
    })
    .filter((x): x is BriefQ => !!x)
    .slice(0, 8);
  if (!qs.length) throw new Error("AI 没有提出问题，也没有给计划。可以再试一次");
  // 界面上已经写着「它的理解：」，它自己再带一个「我的理解：」就重复了
  const note = String(v.note || "")
    .trim()
    .replace(/^(我的理解|我现在的理解|理解)\s*[:：]\s*/, "");
  return { ready: false, note: note || undefined, questions: qs };
}

/** 把一次回复并进讨论记录 */
export function applyReply(b: Brief | undefined, agent: string, reply: ReturnType<typeof parseBrief>): Brief {
  const base: Brief = b ?? { agent, status: "asking", startedAt: Date.now(), rounds: [] };
  if (reply.ready) return { ...base, agent, status: "ready", plan: reply.plan };
  return { ...base, agent, status: "asking", plan: undefined, feedback: undefined, rounds: [...base.rounds, { at: Date.now(), note: reply.note, questions: reply.questions }] };
}

/** 讨论记录写成一篇 Markdown（导出上下文、交给终端里的 AI 时用） */
export function briefDigest(b: Brief) {
  const L = [`# 讨论记录`, ``, `和 ${b.agent} 讨论，${new Date(b.startedAt).toLocaleString("zh-CN")} 开始。`];
  b.rounds.forEach((r, i) => {
    L.push(``, `## 第 ${i + 1} 轮`);
    if (r.note) L.push(``, `AI 的理解：${r.note}`);
    r.questions.forEach((q, k) => L.push(``, `**问 ${k + 1}：${q.q}**${q.why ? `（${q.why}）` : ""}`, ``, (q.a || "").trim() || "（没有回答）"));
  });
  if (b.plan) L.push(``, `## 计划`, ``, b.plan);
  if (b.feedback?.length) L.push(``, `## 对计划的意见`, ``, ...b.feedback.map((f) => "- " + f));
  return L.join("\n");
}
