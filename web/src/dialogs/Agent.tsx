/* 交给 AI：选 AI、工作目录或「作为项目」、提示词；任务模板管理 */
import { Copy, Folder, Plus, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { copyText, desk, errText, isApp, openTarget, v1 } from "../lib/api";
import { patchItem, qc, useConfig, useTemplates, useThisDevice } from "../lib/data";
import { Dialog, openDialog } from "../lib/dialog";
import { buildPrompt, hasImages, localDirOf, noteTitle } from "../lib/logic";
import { ls, useUi } from "../lib/store";
import type { Item, State, Template } from "../lib/types";
import { myWorkspace, recordWorkspace } from "../lib/ws";
import { Button, ErrorText, Field, Pick, Toggle, inputCls, textareaCls } from "../components/ui";

const say = (t: string) => useUi.getState().say(t);
const FALLBACK: Template = { id: "general", name: "通用", goal: "", prompt: "请先读 .xpanel/TASK.md 和 .xpanel/note.md。", resume: "" };

/** 浏览器里没法启动本机 AI：直接复制提示词 */
export function openAgent(it: Item, promptText?: string) {
  if (!isApp) {
    copyText(promptText || buildPrompt(it)).then((ok) => say(ok ? "已复制提示词，粘贴到任意 AI 即可" : "复制失败"));
    return;
  }
  openDialog((close) => <AgentDialog it={it} promptText={promptText} close={close} />);
}

const STATE_TEXT = { new: "新建", ours: "已存在，接着用", other: "已经是另一条笔记的项目，换个名字", busy: "已存在且不是空文件夹，换个名字" };

function AgentDialog({ it, promptText, close }: { it: Item; promptText?: string; close: () => void }) {
  const cfg = useConfig().data?.config;
  const me = useThisDevice();
  const tpls = useTemplates().data;
  const agents = cfg?.agents ?? [];
  const [pick, setPick] = useState(() => Math.max(0, agents.findIndex((a) => a.name === ls.get("wb-agent"))));
  const current = () => qc.getQueryData<State>(["state"])?.items.find((x) => x.id === it.id);
  const real = !!current();
  const ws = real ? myWorkspace(it, me) : null;
  const [proj, setProj] = useState(real && !promptText && (!!ws || it.type === "note" || hasImages(it)));
  const [prompt, setPrompt] = useState("");
  const edited = useRef(false);
  const [cwd, setCwd] = useState(localDirOf(it) || cfg?.agentCwd || "");
  const [name, setName] = useState("");
  const [root, setRoot] = useState("");
  const [tplId, setTplId] = useState("general");
  const [git, setGit] = useState(true);
  const [check, setCheck] = useState<{ path: string; state: keyof typeof STATE_TEXT } | null>(null);
  const [checkErr, setCheckErr] = useState("");
  const [diff, setDiff] = useState("正在同步笔记…");
  const [handoff, setHandoff] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const plain = promptText || buildPrompt(it);
  const tpl = () => (tpls || []).find((t) => t.id === (ws?.template || tplId)) || (tpls || [])[0] || FALLBACK;

  const setP = (v: string) => !edited.current && setPrompt(v);
  // 提示词跟着「作为项目」和模板变
  useEffect(() => {
    if (!proj) setP(plain);
    else if (ws) setP(handoff);
    else setP(tpl().prompt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proj, tplId, tpls, handoff]);
  // 默认模板：有截图的笔记用「复刻」
  useEffect(() => {
    if (tpls && it.type === "note" && hasImages(it) && tpls.some((t) => t.id === "rebuild")) setTplId("rebuild");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tpls]);
  // 新项目：建议的名字和目录
  useEffect(() => {
    if (ws || !real) return;
    desk.wsDefaults(it.type === "note" ? noteTitle(it) : it.title || "", it.id, ls.get("wb-wsroot")).then(
      (d) => (setName(d.name), setRoot(d.root)),
      (e) => setCheckErr(errText(e)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (ws || !real) return;
    if (!name.trim() || !root.trim()) return setCheck(null);
    const t = window.setTimeout(() => {
      desk.wsCheck(root.trim(), name.trim(), it.id).then(
        (c) => (setCheck(c), setCheckErr("")),
        (e) => (setCheck(null), setCheckErr(errText(e))),
      );
    }, 250);
    return () => window.clearTimeout(t);
  }, [name, root, ws, real, it.id]);
  // 已有项目：先同步，再看自上次交给 AI 之后新增了什么
  useEffect(() => {
    if (!ws) return;
    (async () => {
      try {
        await desk.wsSync(current() ?? it, ws.path, true);
        const h = await desk.wsHandoff(ws.path, false);
        setDiff(h.first ? "还没交给过 AI" : h.empty ? "上次交给 AI 之后笔记没有变化" : "自上次交给 AI：" + h.summary);
        setHandoff(h.prompt);
      } catch (e) {
        setDiff(errText(e) + "（文件夹可能被移走了，可以取消勾选「作为项目」直接交给 AI）");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function makeProject() {
    if (ws) {
      await desk.wsSync(current() ?? it, ws.path, true);
      return ws.path;
    }
    if (!check || !["new", "ours"].includes(check.state)) throw new Error("先把项目名和目录填好（下面要显示「新建」）");
    const t = tpl();
    const res = await desk.wsPrepare(current() ?? it, root.trim(), name.trim(), t, git);
    ls.set("wb-wsroot", root.trim());
    await recordWorkspace(it, me, res.path, name.trim(), t.id, agents[pick]?.name || "");
    return res.path;
  }

  async function go() {
    const a = agents[pick];
    if (!a) return;
    setBusy(true);
    setErr("");
    try {
      let dir = cwd.trim();
      if (proj) {
        dir = await makeProject();
        await desk.wsHandoff(dir, true);
      }
      await desk.runAgent(a, dir, prompt);
      ls.set("wb-agent", a.name);
      close();
      say("已交给 " + a.name + (proj ? "，工作目录：" + dir : ""));
      const cur = current();
      if (cur) patchItem(cur, { agentLog: [...(cur.agentLog || []), { agent: a.name, at: Date.now() }].slice(-10) }).catch(() => {});
    } catch (e) {
      setErr(errText(e));
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={ws ? "继续交给 AI" : "交给 AI 处理"}
      onClose={close}
      footer={
        <>
          <Button tone="primary" disabled={!agents.length || busy} onClick={go}>
            <Sparkles className="size-4" />
            {ws ? "继续" : "启动"}
          </Button>
          {!ws && real && proj && (
            <Button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setErr("");
                try {
                  const p = await makeProject();
                  close();
                  say("项目已生成：" + p);
                  openTarget(p);
                } catch (e) {
                  setErr(errText(e));
                  setBusy(false);
                }
              }}
            >
              <Folder className="size-4" />
              只生成项目
            </Button>
          )}
          <span className="grow" />
          <Button onClick={async () => (await copyText(prompt)) && say("已复制提示词")}>
            <Copy className="size-4" />
            只复制提示词
          </Button>
        </>
      }
    >
      {real && !promptText && (
        <Toggle checked={proj} onChange={setProj}>
          作为项目交给 AI
          <span className="text-xs text-faint">在单独的文件夹里干活，笔记的内容和截图都放进去；之后笔记再更新会自动同步</span>
        </Toggle>
      )}
      {proj &&
        (ws ? (
          <div className="flex flex-col gap-1.5 rounded-xl bg-surface-2 px-3.5 py-3">
            <div className="flex items-center gap-2 text-[13.5px]">
              <Folder className="size-4 text-accent" />
              <b>{ws.name}</b>
              <span className="truncate font-mono text-xs text-muted">{ws.path}</span>
              <span className="grow" />
              <Button tone="ghost" onClick={() => openTarget(ws.path)}>
                打开文件夹
              </Button>
            </div>
            <div className="text-xs text-muted">{diff}</div>
          </div>
        ) : (
          <div className="flex flex-col gap-3 rounded-xl bg-surface-2 p-3.5">
            <div className="grid grid-cols-2 gap-3">
              <Field label="项目名">
                <input className={inputCls + " font-mono"} value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} placeholder="leap-motor-code" />
              </Field>
              <Field label="放在">
                <input className={inputCls + " font-mono"} value={root} onChange={(e) => setRoot(e.target.value)} spellCheck={false} placeholder="D:\codes" />
              </Field>
            </div>
            <div className="min-h-5 text-xs">
              {checkErr ? (
                <span className="text-danger">{checkErr}</span>
              ) : check ? (
                <>
                  <span className="font-mono text-muted">{check.path}</span>{" "}
                  <b className={check.state === "new" ? "text-accent" : check.state === "ours" ? "text-ok" : "text-danger"}>{STATE_TEXT[check.state]}</b>
                </>
              ) : (
                <span className="text-faint">填好项目名和目录</span>
              )}
            </div>
            <div className="flex items-end gap-3">
              <Field label="任务模板" className="grow">
                <select className={inputCls} value={tplId} onChange={(e) => (setTplId(e.target.value), (edited.current = false))}>
                  {(tpls || [FALLBACK]).map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Button tone="ghost" onClick={() => openTemplates(() => openAgent(it, promptText))}>
                管理模板…
              </Button>
              <Toggle checked={git} onChange={setGit}>
                git init
              </Toggle>
            </div>
          </div>
        ))}
      {agents.length ? (
        <Pick label="交给哪个 AI" items={agents} value={pick} onChange={setPick} render={(a) => (<><Sparkles />{a.name}</>)} />
      ) : (
        <p className="text-[13px] text-muted">还没有配置 AI，去「设置」里添加。</p>
      )}
      {!proj && (
        <Field label="工作目录（AI 在这个文件夹里干活）">
          <input className={inputCls + " font-mono"} value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="留空 = 用户目录，例如 D:\Workbench 或 \\NAS\share" />
        </Field>
      )}
      <Field label="提示词">
        <textarea
          className={textareaCls + " min-h-[160px] font-mono text-[12.5px]"}
          value={prompt}
          onChange={(e) => {
            edited.current = true;
            setPrompt(e.target.value);
          }}
        />
      </Field>
      <ErrorText>{err}</ErrorText>
    </Dialog>
  );
}

/* ---- 任务模板 ---- */
export function openTemplates(back?: () => void) {
  openDialog((close) => <TemplatesDialog close={() => (close(), back?.())} />);
}

function TemplatesDialog({ close }: { close: () => void }) {
  const { data } = useTemplates();
  const [list, setList] = useState<Template[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (data && !list) setList(JSON.parse(JSON.stringify(data)));
  }, [data, list]);
  const upd = (i: number, ch: Partial<Template>) => setList((l) => l!.map((t, j) => (j === i ? { ...t, ...ch } : t)));
  const saveAll = async (templates: Template[]) => {
    const r = await v1<{ templates: Template[] }>("PUT", "/templates", { templates });
    qc.setQueryData(["templates"], r.templates);
    return r.templates;
  };
  return (
    <Dialog
      wide
      title="任务模板"
      desc="交给 AI 时选一个模板：决定 .xpanel/TASK.md 里的目标、第一次的提示词、以及笔记更新后「继续」时说什么。所有设备共用。"
      onClose={close}
      footer={
        <>
          <Button
            onClick={() =>
              setList((l) => [
                ...(l || []),
                { id: "t" + Date.now().toString(36), name: "新模板", goal: "", prompt: "请先读 .xpanel/TASK.md 和 .xpanel/note.md。", resume: "在已有工作的基础上继续，只处理新增的内容。" },
              ])
            }
          >
            <Plus className="size-4" />
            新模板
          </Button>
          <Button
            tone="ghost"
            title="恢复内置的四个模板"
            onClick={async () => {
              try {
                setList(JSON.parse(JSON.stringify(await saveAll([]))));
                say("已恢复默认模板");
              } catch (e) {
                setErr(errText(e));
              }
            }}
          >
            恢复默认
          </Button>
          <span className="grow" />
          <Button tone="ghost" onClick={close}>
            取消
          </Button>
          <Button
            tone="primary"
            onClick={async () => {
              try {
                await saveAll(list || []);
                say("模板已保存");
                close();
              } catch (e) {
                setErr(errText(e));
              }
            }}
          >
            保存
          </Button>
        </>
      }
    >
      {(list || []).map((t, i) => (
        <div key={t.id} className="flex flex-col gap-2.5 rounded-xl bg-surface-2/60 p-3.5">
          <div className="flex items-center gap-2">
            <input className={inputCls + " max-w-[240px] font-semibold"} value={t.name} onChange={(e) => upd(i, { name: e.target.value })} placeholder="模板名" />
            <span className="text-xs text-faint">id：{t.id}</span>
            <span className="grow" />
            <Button tone="danger" onClick={() => setList((l) => l!.filter((_, j) => j !== i))}>
              删除
            </Button>
          </div>
          <Field label="目标（写进 TASK.md）">
            <textarea className={textareaCls + " min-h-[70px]"} value={t.goal} onChange={(e) => upd(i, { goal: e.target.value })} />
          </Field>
          <Field label="开场提示词">
            <textarea className={textareaCls + " min-h-[70px]"} value={t.prompt} onChange={(e) => upd(i, { prompt: e.target.value })} />
          </Field>
          <Field label="「继续」时追加的提示">
            <textarea className={textareaCls + " min-h-[60px]"} value={t.resume} onChange={(e) => upd(i, { resume: e.target.value })} />
          </Field>
        </div>
      ))}
      <ErrorText>{err}</ErrorText>
    </Dialog>
  );
}
