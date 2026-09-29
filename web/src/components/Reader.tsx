/* 阅读 / 编辑一条：主界面右边的阅读区，和任何页面都能打开的右侧浮出面板（Peek）共用 */
import { Copy, ExternalLink, Folder, Maximize2, Minimize2, PanelRightOpen, Pin, Plus, Sparkles, Trash2, X, FileText } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { copyText, errText, isApp, openTarget } from "../lib/api";
import { addItem, patchItem, qc, removeItem, restoreItem, useAppState, useDevices } from "../lib/data";
import { autoTitle, dueInfo, entryTarget, findTarget, noteTitle, normCat, allCats, allTags, parseDue, setImageWidth, ago, assetMd, fileLabel, isImgFile, clipFiles } from "../lib/logic";
import { ls, useUi, type View } from "../lib/store";
import { qaDigest } from "../lib/qa";
import type { Item, ItemType, Priority, State } from "../lib/types";
import { TYPES, isCheckable, typeName } from "../lib/types";
import { useMyWorkspace } from "../lib/ws";
import { cx } from "../lib/cx";
import { putAsset } from "../lib/api";
import { openAgent } from "../dialogs/Agent";
import { openAsk } from "../dialogs/Ask";
import { Md } from "./Markdown";
import { Button, Chip, IconButton, Segmented } from "./ui";

const STATUS: Record<string, [string, "warn" | "accent" | "danger"]> = { working: ["进行中", "warn"], done: ["完成", "accent"], blocked: ["卡住了", "danger"] };
const say = (t: string, a?: { label: string; run: () => void }) => useUi.getState().say(t, a);
const latest = (it: Item) => qc.getQueryData<State>(["state"])?.items.find((x) => x.id === it.id) ?? it;
export const viewOf = (t: ItemType): View => (t === "note" ? "notes" : t === "link" ? "links" : t === "rule" ? "rules" : t === "inbox" ? "inbox" : "work");

/* ---------------------------------------------------------------- 标签片 */

export function MetaChips({ it, withType = true }: { it: Item; withType?: boolean }) {
  const ui = useUi();
  const di = dueInfo(it);
  const p = (it.agentProgress || []).slice(-1)[0];
  const ws = useMyWorkspace(it);
  const last = (it.agentLog || []).slice(-1)[0];
  const src = it.source as { kind?: string; chat?: string } | undefined;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {withType && <Chip tone="accent">{typeName(it.type)}</Chip>}
      {it.category && (
        <Chip onClick={() => ui.setCat(it.category!)} title="只看这个分类">
          <Folder /> {it.category.replace(/\//g, " / ")}
        </Chip>
      )}
      {it.priority && !it.done && <Chip tone={it.priority === "P0" ? "danger" : it.priority === "P1" ? "warn" : "plain"}>{it.priority}</Chip>}
      {di && <Chip tone={di.tone === "late" ? "danger" : di.tone === "soon" ? "warn" : "plain"}>{di.text}</Chip>}
      {(it.tags || []).map((t) => (
        <Chip key={t} onClick={() => ui.setTag(t)} title="只看这个标签">
          #{t}
        </Chip>
      ))}
      {it.device && <Chip title="相关设备">{it.device}</Chip>}
      {src?.kind === "wechat" && <Chip>来自微信「{src.chat || ""}」</Chip>}
      {ws && (
        <Chip onClick={() => openTarget(ws.path)} title={"打开项目文件夹 " + ws.path}>
          <Folder /> {ws.name}
        </Chip>
      )}
      {p && (
        <Chip tone={STATUS[p.status]?.[1] ?? "warn"} title={`${p.by || "AI"} · ${new Date(p.at).toLocaleString()}\n${String(p.text).slice(0, 300)}`}>
          AI {STATUS[p.status]?.[0] ?? p.status}
        </Chip>
      )}
      {last && (
        <span className="text-xs text-faint" title={(it.agentLog || []).map((x) => x.agent + " · " + new Date(x.at).toLocaleString()).join("\n")}>
          已交给 {last.agent} · {ago(last.at)}
        </span>
      )}
    </div>
  );
}

function ProgressList({ it }: { it: Item }) {
  const list = (it.agentProgress || []).slice().reverse();
  if (!list.length) return null;
  return (
    <section className="mt-8 border-t border-line pt-4">
      <h3 className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-muted">
        <Sparkles className="size-4" /> AI 进展
      </h3>
      <div className="flex flex-col gap-3">
        {list.map((p, i) => (
          <div key={i} className="rounded-xl bg-surface-2 px-3.5 py-2.5">
            <div className="mb-1 flex items-center gap-2 text-xs text-faint">
              <Chip tone={STATUS[p.status]?.[1] ?? "warn"}>{STATUS[p.status]?.[0] ?? p.status}</Chip>
              <span>{p.by || "AI"}</span>
              <span>{new Date(p.at).toLocaleString()}</span>
            </div>
            <Md src={p.text} className="!text-[13.5px]" />
            {(p.files || []).length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1.5 font-mono text-xs text-muted">
                {p.files!.map((f) => (
                  <code key={f}>{f}</code>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- 问答 */

function flash(el: Element | null | undefined) {
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.remove("flash");
  void (el as HTMLElement).offsetWidth;
  el.classList.add("flash");
}

function QaSection({ it, lost, root }: { it: Item; lost: Set<string>; root: React.RefObject<HTMLDivElement | null> }) {
  const pending = useUi((s) => s.qaPending[it.id]) || [];
  const list = (it.qa || []).slice().reverse();
  const [armed, setArmed] = useState<string | null>(null);
  if (!list.length && !pending.length)
    return (
      <section className="qasec mt-8 flex flex-wrap items-center gap-2 border-t border-line-soft pt-4 text-xs text-faint" data-qa-skip>
        选中正文里的一段文字就能「问 AI」，问答会挂在原文旁边。
        <Button tone="ghost" className="h-7 px-2 text-xs" onClick={() => openAsk({ itemId: it.id, quote: "", prefix: "", suffix: "" })}>
          <Sparkles className="size-3.5" />
          针对整篇提问
        </Button>
      </section>
    );
  return (
    <section className="qasec flex flex-col gap-3" aria-label="问答" data-qa-skip>
      <h3 className="flex items-center gap-1.5 text-sm font-semibold text-muted">
        <Sparkles className="size-4" /> 问答 <span className="font-normal text-faint">{list.length}</span>
        <span className="grow" />
        <Button tone="ghost" className="h-7 px-2 text-xs" title="不针对某一段，问整篇" onClick={() => openAsk({ itemId: it.id, quote: "", prefix: "", suffix: "" })}>
          <Plus className="size-3.5" />
          提问
        </Button>
        {list.length > 0 && (
          <Button
            tone="ghost"
            className="h-7 px-2 text-xs"
            title="把这些问答按原文顺序整理成一篇新笔记"
            onClick={async () => {
              const text = root.current?.querySelector("[data-qa-host]")?.textContent || "";
              const n = await addItem({ type: "note", title: `${it.title || "笔记"} · 问答`, body: qaDigest(it, text), category: it.category || undefined, tags: [...(it.tags || [])] }).catch(() => null);
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
      {pending.map((p, i) => (
        <div key={"p" + i} className="flex flex-col gap-1.5 rounded-[14px] border border-dashed border-line p-3">
          <span className="line-clamp-2 rounded bg-mark px-1.5 text-xs text-mark-fg">{p.quote || "整篇笔记"}</span>
          <div className="text-[13.5px] font-semibold">{p.q}</div>
          <div className="flex items-center gap-2 text-xs text-muted">
            <span className="size-3 animate-spin rounded-full border-2 border-accent border-t-transparent" /> 正在问 {p.agent}…
          </div>
        </div>
      ))}
      {list.map((q) => (
        <div key={q.id} data-qa-card={q.id} className="flex flex-col gap-2 rounded-[14px] bg-surface-2 p-3.5">
          <button
            className="line-clamp-3 rounded bg-mark px-1.5 py-0.5 text-left text-xs text-mark-fg"
            title={q.quote ? "定位到原文" : ""}
            onClick={() => q.quote && flash(root.current?.querySelector(`mark[data-qa="${CSS.escape(q.id)}"]`))}
          >
            {q.quote || "整篇笔记"}
            {lost.has(q.id) && <span className="ml-1.5 rounded bg-danger-soft px-1 text-danger">原文已删改</span>}
          </button>
          {(q.turns || []).map((t, i) => (
            <div key={i} className={cx("flex flex-col gap-1", i > 0 && "border-t border-dashed border-line pt-2")}>
              <div className="text-[13.5px] font-semibold text-fg">{t.q}</div>
              <Md src={t.a} className="!text-[13px] !leading-[1.75]" />
              <div className="text-xs text-faint">
                {t.by} · {new Date(t.at).toLocaleString()}
              </div>
            </div>
          ))}
          <div className="flex items-center gap-1">
            <Button tone="ghost" className="h-7 px-2 text-xs" onClick={() => openAsk({ itemId: it.id, quote: q.quote, prefix: q.prefix || "", suffix: q.suffix || "" }, q.id)}>
              追问
            </Button>
            <Button
              tone="ghost"
              className="h-7 px-2 text-xs"
              onClick={async () =>
                say(
                  (await copyText([q.quote ? "> " + q.quote.replace(/\n/g, "\n> ") : "", ...(q.turns || []).map((t) => `**问：** ${t.q}\n\n${t.a}`)].filter(Boolean).join("\n\n")))
                    ? "已复制"
                    : "复制失败",
                )
              }
            >
              复制
            </Button>
            <span className="grow" />
            <Button
              tone="danger"
              className={cx("h-7 px-2 text-xs", armed === q.id && "bg-danger-soft")}
              onClick={() => {
                if (armed !== q.id) return setArmed(q.id);
                const cur = latest(it);
                patchItem(cur, { qa: (cur.qa || []).filter((x) => x.id !== q.id) }).catch(() => {});
              }}
            >
              {armed === q.id ? "再点一次删除" : "删除"}
            </Button>
          </div>
        </div>
      ))}
    </section>
  );
}

/* ---------------------------------------------------------------- 阅读 */

function ReadBody({ it, onEdit }: { it: Item; onEdit: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  // 渲染 Markdown 时顺便记下找不到原文的问答（同一次渲染里问答区接着读）
  const lost = useMemo(() => new Set<string>(), [it.body, it.qa]);
  const onImageWidth = (idx: number, w: number) => {
    const cur = latest(it);
    const body = setImageWidth(cur.body || "", idx, w);
    if (body !== cur.body) patchItem(cur, { body }).catch(() => {});
  };
  return (
    // 阅读区够宽时问答放在右边，窄时放在正文下面
    <div ref={root} className="flex flex-col gap-8 @[960px]:flex-row @[960px]:items-start">
      <article className="min-w-0 max-w-[720px] flex-1">
        <div data-qa-host={it.id} onDoubleClick={(e) => !(e.target as HTMLElement).closest("img,a,button") && onEdit()}>
          {it.body ? (
            <Md src={it.body} qa={it.qa} lost={lost} onImageWidth={onImageWidth} onMark={(id) => flash(root.current?.querySelector(`[data-qa-card="${CSS.escape(id)}"]`))} />
          ) : (
            <p className="text-faint">没有正文，双击或点「编辑」开始写。</p>
          )}
        </div>
        <ProgressList it={it} />
      </article>
      <div className="w-full @[960px]:sticky @[960px]:top-0 @[960px]:w-[280px] @[960px]:shrink-0">
        <QaSection it={it} lost={lost} root={root} />
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- 编辑 */

/** 截图、文件插到光标处：先放「保存中」占位，上传好了换成引用 */
async function insertFiles(files: File[], ta: HTMLTextAreaElement, setBody: (fn: (b: string) => string) => void) {
  for (const f of files) {
    const img = isImgFile(f);
    const ph = `${img ? "!" : ""}[保存中 ${Math.random().toString(36).slice(2, 7)}…]()`;
    const s = ta.selectionStart,
      e = ta.selectionEnd;
    setBody((b) => b.slice(0, s) + ph + b.slice(e));
    try {
      const name = await putAsset(f);
      setBody((b) => b.replace(ph, assetMd(img, fileLabel(f), name)));
      say(img ? "截图已保存并插入" : "文件已保存并附上");
    } catch (x) {
      setBody((b) => b.replace(ph, ""));
      say("保存失败：" + errText(x));
    }
  }
}

const smallInput = "h-8 rounded-lg bg-surface-2 px-2.5 text-[13px] outline-none focus:ring-2 focus:ring-accent/40";

function Editor({ it, onLive, focusTitle }: { it: Item; onLive?: (body: string) => void; focusTitle?: boolean }) {
  const { data } = useAppState();
  const devices = useDevices();
  const [title, setTitle] = useState(it.title);
  const [body, setBodyRaw] = useState(it.body || "");
  const [saved, setSaved] = useState("已保存");
  const timer = useRef<number | undefined>(undefined);
  const cur = useRef({ title, body });
  cur.current = { title, body };
  const ta = useRef<HTMLTextAreaElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  const flush = () => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    const x = latest(it);
    let t = cur.current.title.trim();
    const b = cur.current.body;
    if (!t && x.type === "link") {
      const tg = findTarget(b);
      if (tg) t = autoTitle(tg);
    }
    if (!t && x.type !== "note") {
      setSaved("标题不能为空");
      if (b === (x.body || "")) return;
      t = x.title;
    }
    if (t === x.title && b === (x.body || "")) return setSaved("已保存");
    patchItem(x, { title: t, body: b }).then(
      () => setSaved("已保存"),
      () => setSaved("保存失败"),
    );
  };
  const schedule = () => {
    setSaved("正在保存…");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, 700);
  };
  const setBody = (fn: (b: string) => string) => {
    const n = fn(cur.current.body);
    cur.current = { ...cur.current, body: n };
    setBodyRaw(n);
    onLive?.(n);
    schedule();
  };
  useEffect(() => {
    if (focusTitle) titleRef.current?.focus();
    else ta.current?.focus();
    const save = () => timer.current !== undefined && flush();
    window.addEventListener("beforeunload", save);
    return () => {
      window.removeEventListener("beforeunload", save);
      save();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cats = allCats(data?.items ?? [], data?.categories ?? []);
  const tags = allTags(data?.items ?? []).map((x) => x[0]);
  const set = (ch: Partial<Item>) => patchItem(latest(it), ch);
  const x = latest(it);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" data-editor>
      <input
        ref={titleRef}
        value={title}
        onChange={(e) => {
          setTitle(e.target.value);
          schedule();
        }}
        onBlur={flush}
        placeholder={x.type === "note" ? noteTitle({ ...x, title: "" }) : x.type === "link" ? "名称，如：项目面板" : "标题"}
        className="bg-transparent text-[24px] font-bold text-fg outline-none placeholder:text-faint"
        aria-label="标题"
      />
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <input
          list="xp-cats"
          defaultValue={x.category || ""}
          key={"c" + (x.category || "")}
          onBlur={(e) => {
            const v = normCat(e.target.value);
            if (v !== (x.category || "")) set({ category: v || undefined }).then(() => say(v ? "已放到「" + v + "」" : "已设为未分类"));
          }}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          placeholder="分类，如 工作/周报"
          className={smallInput + " w-44"}
          aria-label="分类"
        />
        <datalist id="xp-cats">
          {cats.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
        <TagInput tags={x.tags || []} all={tags} onChange={(t) => set({ tags: t })} />
        <select value={x.device || ""} onChange={(e) => set({ device: e.target.value })} className={smallInput} aria-label="设备">
          <option value="">不限设备</option>
          {[...new Set([...devices.map((d) => d.name), ...(x.device ? [x.device] : [])])].map((d) => (
            <option key={d}>{d}</option>
          ))}
        </select>
        {isCheckable(x.type) && (
          <>
            <select value={x.priority || ""} onChange={(e) => set({ priority: (e.target.value || undefined) as Priority | undefined })} className={smallInput} aria-label="优先级">
              <option value="">无优先级</option>
              <option value="P0">P0 紧急</option>
              <option value="P1">P1 高</option>
              <option value="P2">P2 中</option>
              <option value="P3">P3 低</option>
            </select>
            <input type="date" value={x.due || ""} onChange={(e) => set({ due: e.target.value || undefined })} className={smallInput} aria-label="截止日期" />
            <span className="flex gap-0.5 text-xs">
              {["今天", "明天", "下周一"].map((w) => (
                <button key={w} className="rounded-md px-1.5 py-1 text-muted hover:bg-surface-3 hover:text-fg" onClick={() => set({ due: parseDue(w) || undefined })}>
                  {w}
                </button>
              ))}
              {x.due && (
                <button className="rounded-md px-1.5 py-1 text-muted hover:bg-surface-3 hover:text-fg" title="清除日期" onClick={() => set({ due: undefined })}>
                  ×
                </button>
              )}
            </span>
          </>
        )}
        <span className="ml-auto text-xs text-faint">{saved}</span>
      </div>
      <textarea
        ref={ta}
        value={body}
        onChange={(e) => {
          const v = e.target.value;
          setBody(() => v);
        }}
        onBlur={flush}
        onPaste={(e) => {
          const files = clipFiles(e.clipboardData);
          if (!files.length) return;
          e.preventDefault();
          insertFiles(files, e.currentTarget, setBody);
        }}
        onDragOver={(e) => e.dataTransfer.types.includes("Files") && e.preventDefault()}
        onDrop={(e) => {
          const files = clipFiles(e.dataTransfer);
          if (!files.length) return;
          e.preventDefault();
          e.stopPropagation();
          insertFiles(files, e.currentTarget, setBody);
        }}
        placeholder={
          x.type === "link"
            ? "网址或路径，如 \\\\NAS\\share、http://192.168.1.10:8080；下面可以写备注"
            : "支持 Markdown：# 标题、- 列表、- [ ] 待办、`代码`、表格…  截图可以直接粘贴，文件可以拖进来"
        }
        className="min-h-0 flex-1 resize-none rounded-xl bg-surface-2 px-4 pt-4 pb-28 font-mono text-[13.5px] leading-[1.8] text-fg outline-none focus:ring-2 focus:ring-accent/30"
        aria-label="正文"
      />
    </div>
  );
}

function TagInput({ tags, all, onChange }: { tags: string[]; all: string[]; onChange: (t: string[]) => void }) {
  const [v, setV] = useState("");
  const add = () => {
    const more = v.split(/[\s,，]+/).map((s) => s.replace(/^#/, "").trim()).filter(Boolean);
    setV("");
    if (more.length) onChange([...new Set([...tags, ...more])]);
  };
  return (
    <span className="flex flex-wrap items-center gap-1">
      {tags.map((t) => (
        <span key={t} className="inline-flex items-center gap-0.5 rounded-md bg-surface-3 pl-2 text-xs text-fg-2">
          #{t}
          <button aria-label={"去掉标签 " + t} title="去掉" className="px-1.5 text-faint hover:text-danger" onClick={() => onChange(tags.filter((x) => x !== t))}>
            ×
          </button>
        </span>
      ))}
      <input
        list="xp-tags"
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            add();
          }
        }}
        onBlur={add}
        placeholder="+ 标签"
        className={smallInput + " w-24"}
        aria-label="添加标签"
      />
      <datalist id="xp-tags">
        {all.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
    </span>
  );
}

/* ---------------------------------------------------------------- 整体 */

type Mode = "read" | "edit" | "split";

function ItemView({ it, mode, setMode, bar, wide, focusTitle }: { it: Item; mode: Mode; setMode: (m: Mode) => void; bar?: ReactNode; wide: boolean; focusTitle?: boolean }) {
  const ui = useUi();
  const [armed, setArmed] = useState(false);
  const [live, setLive] = useState<string | null>(null);
  const tg = it.type === "link" ? entryTarget(it) : null;
  const ws = useMyWorkspace(it);
  useEffect(() => {
    setArmed(false);
    setLive(null);
  }, [it.id, mode]);

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b border-line-soft px-5 py-3.5">
        <Segmented
          label="显示方式"
          value={mode}
          onChange={setMode}
          options={
            wide
              ? [
                  ["read", "阅读"],
                  ["edit", "编辑"],
                  ["split", "分栏"],
                ]
              : [
                  ["read", "阅读"],
                  ["edit", "编辑"],
                ]
          }
        />
        <span className="grow" />
        {isCheckable(it.type) && (
          <Button tone={it.done ? "soft" : "primary"} onClick={() => patchItem(it, { done: !it.done })}>
            {it.done ? "取消完成" : TYPES.find((t) => t.k === it.type)?.check}
          </Button>
        )}
        {tg && (
          <Button tone="primary" onClick={() => openTarget(tg).then((r) => r === "copied" && say("网页版不能直接打开本地路径，已复制：" + tg))}>
            <ExternalLink className="size-4" />
            打开
          </Button>
        )}
        <select
          value={it.type}
          onChange={(e) => {
            const k = e.target.value as ItemType;
            patchItem(it, k === "note" || it.type !== "note" ? { type: k } : { type: k, title: noteTitle(it) });
            say(`已归类到「${typeName(k)}」`);
          }}
          className="h-[34px] rounded-[10px] bg-surface-3 px-2.5 text-[13px] text-fg-2 outline-none"
          aria-label="类型"
        >
          {it.type === "inbox" && <option value="inbox">收件箱（未归类）</option>}
          {TYPES.map((t) => (
            <option key={t.k} value={t.k}>
              {t.name}
            </option>
          ))}
        </select>
        <IconButton label={ws ? "继续交给 AI（笔记有更新时只交新增的）" : isApp ? "交给 AI" : "复制给 AI 的提示词"} onClick={() => openAgent(latest(it))}>
          <Sparkles />
        </IconButton>
        <IconButton label={it.pinned ? "移出焦点 / 取消置顶" : "设为焦点 / 置顶"} onClick={() => patchItem(it, { pinned: !it.pinned })} className={it.pinned ? "text-accent" : ""}>
          <Pin />
        </IconButton>
        <IconButton
          label={tg ? "复制网址或路径" : "复制 Markdown"}
          onClick={async () => say((await copyText(tg || `# ${it.title}\n\n${it.body || ""}`)) ? "已复制" : "复制失败")}
        >
          <Copy />
        </IconButton>
        <IconButton
          label={armed ? "再点一次删除" : "删除"}
          className={armed ? "bg-danger-soft text-danger" : ""}
          onClick={async () => {
            if (!armed) return setArmed(true);
            const copy = latest(it);
            await removeItem(it.id).catch(() => {});
            if (ui.peek?.id === it.id) ui.closePeek();
            say("已删除", { label: "撤销", run: () => restoreItem(copy) });
          }}
        >
          <Trash2 />
        </IconButton>
        {bar}
      </div>
      {mode === "read" ? (
        <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-8 pt-6 pb-40 @container">
          <MetaChips it={it} />
          <h2 className="mt-3 mb-4 text-[26px] leading-snug font-bold text-fg">{it.type === "note" ? noteTitle(it) : it.title}</h2>
          {tg && <div className="mb-4 rounded-lg bg-surface-2 px-3 py-2 font-mono text-[13px] break-all text-muted">{tg}</div>}
          <ReadBody it={it} onEdit={() => setMode("edit")} />
        </div>
      ) : (
        <div className={cx("flex min-h-0 flex-1 gap-6 px-8 py-5", mode === "split" && "flex-row")}>
          <div className={cx("flex min-h-0 flex-col", mode === "split" ? "w-1/2" : "flex-1")}>
            <Editor key={it.id} it={it} onLive={mode === "split" ? setLive : undefined} focusTitle={focusTitle} />
          </div>
          {mode === "split" && (
            <div className="scroll-quiet min-h-0 w-1/2 overflow-y-auto pb-40">
              <Md src={live ?? it.body ?? ""} />
            </div>
          )}
        </div>
      )}
    </>
  );
}

/** 主界面右边的阅读区 */
export function Reader() {
  const { data } = useAppState();
  const ui = useUi();
  const id = ui.selected[ui.view];
  const it = id ? data?.items.find((x) => x.id === id) : undefined;
  const [focusTitle, setFocusTitle] = useState(false);
  useEffect(() => {
    // 新建的条目（标题空）直接写标题
    setFocusTitle(!!it && !it.title && it.type !== "note");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (!it)
    return (
      <main className="grid min-w-0 flex-1 place-items-center rounded-[18px] bg-surface p-6 text-center text-sm text-faint shadow-2">
        {ui.view === "notes" ? (
          <div className="flex flex-col items-center gap-3">
            <FileText className="size-8 text-line" />
            临时的内容、会议记录、粘贴来的长文本都放这里。
            <br />
            支持 Markdown，可以直接粘贴图片和拖入文件。
          </div>
        ) : (
          "从左边选一条"
        )}
      </main>
    );
  return (
    <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-[18px] bg-surface shadow-2">
      <ItemView it={it} mode={ui.mode} setMode={ui.setMode} wide focusTitle={focusTitle} />
    </main>
  );
}

/* ---------------------------------------------------------------- 右侧浮出面板 */

const sideWidth = () => Math.max(380, Math.min(+(ls.get("wb-sidew") || 0) || 620, window.innerWidth - 420));

/** 在任何页面打开任意一条（收件箱里的消息、刚整理出来的笔记…）；可以拖左边缘调宽度，也可以铺满 */
export function Peek() {
  const { data } = useAppState();
  const ui = useUi();
  const it = ui.peek ? data?.items.find((x) => x.id === ui.peek!.id) : undefined;
  const [w, setW] = useState(sideWidth);
  useEffect(() => {
    if (ui.peek && data && !it) ui.closePeek();
  }, [ui.peek, data, it, ui]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !ui.peek) return;
      const a = document.activeElement as HTMLElement | null;
      if (a && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) return;
      if (document.querySelector('[role="dialog"]')) return;
      ui.closePeek();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [ui]);
  if (!it || !ui.peek) return null;
  const full = ui.peekFull;
  return (
    <aside
      aria-label="右侧阅读"
      style={full ? undefined : { width: w }}
      className={cx("fixed top-4 right-4 bottom-4 z-30 flex flex-col overflow-hidden rounded-[18px] border border-line bg-surface shadow-3", full && "left-4")}
    >
      {!full && (
        <div
          title="拖动调整宽度"
          className="absolute top-0 bottom-0 left-0 z-10 w-1.5 cursor-ew-resize hover:bg-accent/30"
          onPointerDown={(e) => {
            e.preventDefault();
            const el = e.currentTarget;
            const x0 = e.clientX,
              w0 = w;
            let cur = w0;
            el.setPointerCapture(e.pointerId);
            const move = (ev: PointerEvent) => {
              cur = Math.max(380, Math.min(window.innerWidth - 420, w0 + x0 - ev.clientX));
              setW(cur);
            };
            const up = () => {
              el.removeEventListener("pointermove", move);
              el.removeEventListener("pointerup", up);
              ls.set("wb-sidew", String(Math.round(cur)));
            };
            el.addEventListener("pointermove", move);
            el.addEventListener("pointerup", up);
          }}
        />
      )}
      <ItemView
        it={it}
        mode={ui.peek.mode}
        setMode={(m) => ui.openPeek(it.id, m === "split" ? "edit" : m)}
        wide={full}
        bar={
          <>
            <IconButton
              label="在它所在的页面打开"
              onClick={() => {
                const v = viewOf(it.type);
                ui.setView(v);
                useUi.getState().select(it.id);
                ui.closePeek();
              }}
            >
              <PanelRightOpen />
            </IconButton>
            <IconButton label={full ? "还原" : "铺满"} onClick={() => useUi.setState({ peekFull: !full })}>
              {full ? <Minimize2 /> : <Maximize2 />}
            </IconButton>
            <IconButton label="关闭（Esc）" onClick={ui.closePeek}>
              <X />
            </IconButton>
          </>
        }
      />
    </aside>
  );
}
