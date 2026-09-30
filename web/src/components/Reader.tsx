/* 阅读 / 编辑一条：主界面右边的阅读区，和任何页面都能打开的右侧浮出面板（Peek）共用 */
import { CalendarDays, Copy, Link2, ExternalLink, FilePlus2, FoldHorizontal, UnfoldHorizontal, Flag, Folder, FolderInput, Hash, Monitor, Maximize2, Minimize2, PanelRightOpen, Pin, Sparkles, Trash2, X, FileText } from "lucide-react";
import { create } from "zustand";
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { copyText, errText, isApp, openTarget } from "../lib/api";
import { addItem, patchItem, qc, removeItem, restoreItem, useAppState, useDevices } from "../lib/data";
import { addLink } from "../lib/links";
import { autoTitle, dueInfo, entryTarget, findTarget, noteTitle, normCat, allCats, allTags, parseDue, setImageWidth, ago, assetMd, fileLabel, isImgFile, clipFiles } from "../lib/logic";
import { ls, useUi, type View } from "../lib/store";
import type { Item, ItemType, Priority, State } from "../lib/types";
import { TYPES, isCheckable, typeName } from "../lib/types";
import { useMyWorkspace } from "../lib/ws";
import { cx } from "../lib/cx";
import { putAsset } from "../lib/api";
import { openAgent } from "../dialogs/Agent";
import { Md } from "./Markdown";
import { CommentsSection, flash } from "./Comments";
import { Breadcrumb, ChildNotes, openMove, type OpenFn } from "./Tree";
import { RelatedSection, openLinkPicker } from "./Related";
import { addChild, canNest } from "../lib/tree";
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
    <section className="mt-12">
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

/* ---------------------------------------------------------------- 阅读 */

function ReadBody({ it, onEdit, open }: { it: Item; onEdit: () => void; open: OpenFn }) {
  const root = useRef<HTMLDivElement>(null);
  // 渲染 Markdown 时顺便记下找不到原文的问答（同一次渲染里问答区接着读）
  const lost = useMemo(() => new Set<string>(), [it.body, it.qa]);
  const onImageWidth = (idx: number, w: number) => {
    const cur = latest(it);
    const body = setImageWidth(cur.body || "", idx, w);
    if (body !== cur.body) patchItem(cur, { body }).catch(() => {});
  };
  return (
    <div ref={root}>
      <article className="min-w-0">
        <div data-qa-host={it.id} onDoubleClick={(e) => !(e.target as HTMLElement).closest("img,a,button") && onEdit()}>
          {it.body ? (
            <Md src={it.body} qa={it.qa} lost={lost} onImageWidth={onImageWidth} onMark={(id) => flash(root.current?.querySelector(`[data-qa-card="${CSS.escape(id)}"]`))} />
          ) : (
            <p className="text-faint">没有正文，双击或点「编辑」开始写。</p>
          )}
        </div>
        <ProgressList it={it} />
      </article>
      {it.type !== "inbox" && <RelatedSection it={it} />}
      {canNest(it) && <ChildNotes it={it} open={open} />}
      <CommentsSection it={it} lost={lost} root={root} />
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

/* 编辑时的属性（分类、标签、设备…）：平时就是一行淡色文字，鼠标移上去 / 输入时才有浅底色，不画框 */
const quiet =
  "h-7 min-w-0 appearance-none rounded-md bg-transparent px-1.5 text-[13px] text-muted outline-none transition-colors placeholder:text-faint hover:bg-surface-2 focus:bg-surface-2 focus:text-fg";
const smallInput = quiet;
function Prop({ icon: Icon, children, title }: { icon: typeof Folder; children: ReactNode; title: string }) {
  return (
    <span className="inline-flex items-center gap-0.5 text-faint [&>svg]:size-3.5 [&>svg]:shrink-0" title={title}>
      <Icon />
      {children}
    </span>
  );
}

const noLost = new Set<string>();
// 块编辑器比较大，第一次进编辑时再加载
const BlockEditor = lazy(() => import("./BlockEditor").then((m) => ({ default: m.BlockEditor })));

/** rich：所见即所得的块编辑器；否则是 Markdown 源码 */
function Editor({ it, rich, focusTitle, open }: { it: Item; rich: boolean; focusTitle?: boolean; open: OpenFn }) {
  const richApi = useRef<((peek?: boolean) => string | null) | null>(null);
  const { data } = useAppState();
  /* 多台电脑同时开着同一篇：base 是这边最后一次和主机一致的内容。
     - 这边没改过、别处改了 → 直接换成别处的版本（不会拿旧内容去覆盖）
     - 两边都改了 → 不自动保存，提示选用哪一份 */
  const base = useRef({ title: it.title || "", body: it.body || "" });
  const [conflict, setConflict] = useState<Item | null>(null);
  const conflictRef = useRef<Item | null>(null);
  conflictRef.current = conflict;
  const alive = useRef(true);
  const [rev, setRev] = useState(0);
  const devices = useDevices();
  const [title, setTitle] = useState(it.title);
  const [body, setBodyRaw] = useState(it.body || "");
  const [saved, setSaved] = useState("已保存");
  const timer = useRef<number | undefined>(undefined);
  const cur = useRef({ title, body });
  cur.current = { title, body };
  const ta = useRef<HTMLTextAreaElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const edRoot = useRef<HTMLDivElement>(null);

  /** 这边现在的内容（peek：不打断编辑器里还没交出来的改动） */
  const mine = (peek?: boolean) => {
    const fresh = richApi.current?.(peek);
    if (fresh != null && !peek) cur.current = { ...cur.current, body: fresh };
    return { title: cur.current.title, body: fresh ?? cur.current.body };
  };
  const changed = (m: { title: string; body: string }) => m.title.trim() !== base.current.title.trim() || m.body !== base.current.body;
  const remoteMoved = (x: Item) => (x.title || "") !== base.current.title || (x.body || "") !== base.current.body;
  const adopt = (x: Item) => {
    base.current = { title: x.title || "", body: x.body || "" };
    cur.current = { ...base.current };
    setTitle(base.current.title);
    setBodyRaw(base.current.body);
    setRev((r) => r + 1);
  };
  /** 两边都改了、又没法问（比如关掉了）：把这边的另存一篇并关联，不覆盖别处的 */
  const keepMineAsCopy = async (m: { title: string; body: string }, x: Item) => {
    const n = await addItem({ type: "note", title: `${m.title.trim() || x.title || "笔记"}（冲突时这台电脑的版本）`, body: m.body, category: x.category || undefined, tags: [...(x.tags || [])] }).catch(() => null);
    if (!n) return;
    await addLink(x, n.id, "冲突版本").catch(() => {});
    say(`另一台电脑也改了「${x.title || "这篇"}」，这边的修改另存为一篇并关联了`, { label: "打开", run: () => useUi.getState().openPeek(n.id) });
  };

  const flush = () => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    const x = latest(it);
    const m = mine();
    if (!changed(m)) return alive.current && setSaved("已保存");
    if (remoteMoved(x)) {
      // 别处也改过：内容正好一样就算了，否则不覆盖
      if ((x.body || "") === m.body && (x.title || "") === m.title.trim()) {
        base.current = { title: x.title || "", body: x.body || "" };
        return alive.current && setSaved("已保存");
      }
      if (!alive.current) return void keepMineAsCopy(m, x);
      setConflict(x);
      return setSaved("没保存：另一台电脑也改了");
    }
    if (conflictRef.current) return;
    let t = m.title.trim();
    const b = m.body;
    if (!t && x.type === "link") {
      const tg = findTarget(b);
      if (tg) t = autoTitle(tg);
    }
    if (!t && x.type !== "note") {
      setSaved("标题不能为空");
      if (b === (x.body || "")) return;
      t = x.title;
    }
    if (t === x.title && b === (x.body || "")) return alive.current && setSaved("已保存");
    // 主机上的标题、正文应该还是这边最后一次同步到的样子；对不上（别处刚改过）主机会拒绝，不会被覆盖
    const prev = base.current;
    base.current = { title: t, body: b };
    patchItem(x, { title: t, body: b }, { expect: { title: prev.title, body: prev.body } }).then(
      () => alive.current && setSaved("已保存"),
      (e) => {
        base.current = prev;
        // 编辑器已经关了：这边的改动另存一篇，别丢
        if (!alive.current) return void (/另一台电脑/.test(errText(e)) && keepMineAsCopy({ title: t, body: b }, latest(it)));
        setSaved(/另一台电脑/.test(errText(e)) ? "没保存：另一台电脑也改了" : "保存失败");
      },
    );
  };
  // 主机上的内容变了（别的电脑改的）
  useEffect(() => {
    const x = latest(it);
    if (!remoteMoved(x)) return;
    const m = mine(true);
    if ((x.body || "") === m.body && (x.title || "") === m.title.trim()) {
      base.current = { title: x.title || "", body: x.body || "" };
      return;
    }
    if (!changed(m)) {
      adopt(x);
      setSaved("已换成其他电脑刚保存的内容");
      return;
    }
    window.clearTimeout(timer.current);
    timer.current = undefined;
    setConflict(x);
    setSaved("没保存：另一台电脑也改了");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [it.title, it.body]);
  const schedule = () => {
    setSaved("正在保存…");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, 700);
  };
  const setBody = (fn: (b: string) => string) => {
    const n = fn(cur.current.body);
    cur.current = { ...cur.current, body: n };
    setBodyRaw(n);
    schedule();
  };
  useEffect(() => {
    if (focusTitle) titleRef.current?.focus();
    else if (!rich) ta.current?.focus();
    const save = () => timer.current !== undefined && flush();
    window.addEventListener("beforeunload", save);
    return () => {
      window.removeEventListener("beforeunload", save);
      alive.current = false;
      // 有冲突没处理就关掉了：这边的另存一份；否则照常保存（flush 自己会再检查一次）
      const c = conflictRef.current;
      if (c) {
        const m = mine();
        if (changed(m)) void keepMineAsCopy(m, latest(it));
      } else save();
      // 编辑器卸载时可能还会交出最后的改动，稍后再存一次
      window.setTimeout(() => !conflictRef.current && flush(), 0);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cats = allCats(data?.items ?? [], data?.categories ?? []);
  const tags = allTags(data?.items ?? []).map((x) => x[0]);
  const set = (ch: Partial<Item>) => patchItem(latest(it), ch);
  const x = latest(it);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2" data-editor>
      <Breadcrumb it={x} open={open} />
      <input
        ref={titleRef}
        value={title}
        onChange={(e) => {
          setTitle(e.target.value);
          schedule();
        }}
        onBlur={flush}
        placeholder={x.type === "note" ? noteTitle({ ...x, title: "" }) : x.type === "link" ? "名称，如：项目面板" : "标题"}
        className="bg-transparent text-[26px] leading-snug font-bold text-fg outline-none placeholder:text-faint"
        aria-label="标题"
      />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
        <Prop icon={Folder} title="分类（可用 / 分层）">
          <input
            list="xp-cats"
            defaultValue={x.category || ""}
            key={"c" + (x.category || "")}
            onBlur={(e) => {
              const v = normCat(e.target.value);
              if (v !== (x.category || "")) set({ category: v || undefined }).then(() => say(v ? "已放到「" + v + "」" : "已设为未分类"));
            }}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            placeholder="未分类"
            className={quiet + " field-sizing-content min-w-12"}
            aria-label="分类"
          />
        </Prop>
        <datalist id="xp-cats">
          {cats.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
        <Prop icon={Hash} title="标签">
          <TagInput tags={x.tags || []} all={tags} onChange={(t) => set({ tags: t })} />
        </Prop>
        {(devices.length > 0 || x.device) && (
          <Prop icon={Monitor} title="相关设备">
            <select value={x.device || ""} onChange={(e) => set({ device: e.target.value })} className={quiet} aria-label="设备">
              <option value="">不限设备</option>
              {[...new Set([...devices.map((d) => d.name), ...(x.device ? [x.device] : [])])].map((d) => (
                <option key={d}>{d}</option>
              ))}
            </select>
          </Prop>
        )}
        {isCheckable(x.type) && (
          <>
            <Prop icon={Flag} title="优先级">
              <select value={x.priority || ""} onChange={(e) => set({ priority: (e.target.value || undefined) as Priority | undefined })} className={quiet} aria-label="优先级">
                <option value="">无优先级</option>
                <option value="P0">P0 紧急</option>
                <option value="P1">P1 高</option>
                <option value="P2">P2 中</option>
                <option value="P3">P3 低</option>
              </select>
            </Prop>
            <Prop icon={CalendarDays} title="截止日期">
              <input type="date" value={x.due || ""} onChange={(e) => set({ due: e.target.value || undefined })} className={quiet} aria-label="截止日期" />
              <span className="flex gap-0.5 text-xs">
                {["今天", "明天", "下周一"].map((w) => (
                  <button key={w} className="rounded-md px-1.5 py-1 text-faint hover:bg-surface-2 hover:text-fg" onClick={() => set({ due: parseDue(w) || undefined })}>
                    {w}
                  </button>
                ))}
                {x.due && (
                  <button className="rounded-md px-1.5 py-1 text-faint hover:bg-surface-2 hover:text-fg" title="清除日期" onClick={() => set({ due: undefined })}>
                    ×
                  </button>
                )}
              </span>
            </Prop>
          </>
        )}
        <span className="ml-auto text-xs text-faint">{saved}</span>
      </div>
      {conflict && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl bg-warn-soft px-3.5 py-2.5 text-[13px] text-warn-fg">
          <span className="grow">
            <b>另一台电脑也改了这篇</b>，这边还有没保存的修改，先选一下留哪份。
          </span>
          <Button
            tone="ghost"
            className="h-7 px-2 text-xs"
            title="换成另一台电脑的版本；这边的修改复制到剪贴板"
            onClick={async () => {
              const m = mine();
              await copyText(m.body);
              const x = latest(it);
              setConflict(null);
              adopt(x);
              setSaved("已换成另一台电脑的版本");
              say("已换成另一台电脑的版本，你这边的内容复制到剪贴板了");
            }}
          >
            用对方的
          </Button>
          <Button
            tone="ghost"
            className="h-7 px-2 text-xs"
            title="用这边的内容覆盖另一台电脑的"
            onClick={() => {
              const x = latest(it);
              base.current = { title: x.title || "", body: x.body || "" };
              setConflict(null);
              conflictRef.current = null;
              flush();
            }}
          >
            用我的
          </Button>
          <Button
            tone="soft"
            className="h-7 px-2.5 text-xs"
            title="这边的另存为一篇并关联，这篇换成另一台电脑的版本"
            onClick={async () => {
              const m = mine();
              const x = latest(it);
              setConflict(null);
              adopt(x);
              await keepMineAsCopy(m, x);
            }}
          >
            两份都留
          </Button>
        </div>
      )}
      {rich ? (
        <div ref={edRoot} className="-ml-12 mt-2 flex min-h-0 flex-1 flex-col overflow-y-auto scroll-quiet">
          <Suspense fallback={<div className="flex-[1_0_auto] pl-12 text-sm text-faint">正在打开编辑器…</div>}>
            <BlockEditor key={rev} value={body} itemId={it.id} api={richApi} onChange={(md) => setBody(() => md)} />
          </Suspense>
          {x.type !== "link" && (
            <div className="pb-40 pl-12" data-qa-skip>
              <RelatedSection it={x} />
              <CommentsSection it={x} lost={noLost} root={edRoot} />
            </div>
          )}
        </div>
      ) : (
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
          spellCheck={false}
          className="mt-2 min-h-0 flex-1 resize-none bg-transparent pb-40 text-[15px] leading-[1.85] text-fg-2 outline-none placeholder:text-faint"
          aria-label="正文"
        />
      )}
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
        <span key={t} className="group/tag inline-flex items-center rounded-md pl-1 text-[13px] text-fg-2 hover:bg-surface-2">
          {t}
          <button aria-label={"去掉标签 " + t} title="去掉" className="px-1 text-faint opacity-0 group-hover/tag:opacity-100 hover:text-danger" onClick={() => onChange(tags.filter((x) => x !== t))}>
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
        placeholder={tags.length ? "+" : "添加标签"}
        className={smallInput + " field-sizing-content min-w-6"}
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

/** 宽屏时正文默认居中、限宽（好读）；可以切成铺满 */
const useFullWidth = create<{ on: boolean; toggle: () => void }>((set) => ({
  on: ls.get("wb-fullwidth") === "1",
  toggle: () =>
    set((s) => {
      ls.set("wb-fullwidth", s.on ? null : "1");
      return { on: !s.on };
    }),
}));

function ItemView({
  it,
  mode,
  setMode,
  bar,
  wide,
  focusTitle,
  open,
}: {
  it: Item;
  mode: Mode;
  setMode: (m: Mode) => void;
  bar?: ReactNode;
  wide: boolean;
  focusTitle?: boolean;
  open: OpenFn;
}) {
  const ui = useUi();
  const full = useFullWidth((s) => s.on);
  const [armed, setArmed] = useState(false);
  const tg = it.type === "link" ? entryTarget(it) : null;
  const ws = useMyWorkspace(it);
  useEffect(() => {
    setArmed(false);
  }, [it.id, mode]);

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 px-5 pt-3.5 pb-1">
        <Segmented
          label="显示方式"
          value={mode}
          onChange={setMode}
          options={
            wide
              ? [
                  ["read", "阅读"],
                  ["edit", "编辑"],
                  ["split", "Markdown"],
                ]
              : [
                  ["read", "阅读"],
                  ["edit", "编辑"],
                ]
          }
        />
        <span className="grow" />
        {wide && (
          <IconButton label={full ? "适中宽度（正文居中）" : "全宽显示"} onClick={() => useFullWidth.getState().toggle()}>
            {full ? <FoldHorizontal /> : <UnfoldHorizontal />}
          </IconButton>
        )}
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
        {canNest(it) && (
          <>
            <IconButton
              label="新建子笔记"
              onClick={async () => {
                const n = await addChild(latest(it)).catch(() => null);
                if (n) open(n.id, true);
              }}
            >
              <FilePlus2 />
            </IconButton>
            <IconButton label="移动到…（放到另一篇下面）" onClick={() => openMove(latest(it))}>
              <FolderInput />
            </IconButton>
          </>
        )}
        {it.type !== "inbox" && (
          <IconButton label="关联…（岗位、简历、题库等）" onClick={() => openLinkPicker(latest(it))}>
            <Link2 />
          </IconButton>
        )}
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
            // 子笔记会往上挪一层；撤销时挪回来
            const kids = (qc.getQueryData<State>(["state"])?.items ?? []).filter((x) => x.parentId === it.id).map((x) => x.id);
            await removeItem(it.id).catch(() => {});
            if (ui.peek?.id === it.id) ui.closePeek();
            say(kids.length ? `已删除，${kids.length} 篇子笔记移到了上一层` : "已删除", {
              label: "撤销",
              run: async () => {
                await restoreItem(copy);
                const now = qc.getQueryData<State>(["state"])?.items ?? [];
                for (const k of kids) {
                  const x = now.find((y) => y.id === k);
                  if (x) await patchItem(x, { parentId: it.id }).catch(() => {});
                }
              },
            });
          }}
        >
          <Trash2 />
        </IconButton>
        {bar}
      </div>
      {mode === "read" ? (
        <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-14 pt-6 pb-40 @container">
          <div className={cx("mx-auto w-full", !full && "max-w-[880px]")}>
            <Breadcrumb it={it} open={open} />
            <MetaChips it={it} />
            <h2 className="mt-3 mb-4 text-[26px] leading-snug font-bold text-fg">{it.type === "note" ? noteTitle(it) : it.title}</h2>
            {tg && <div className="mb-4 rounded-lg bg-surface-2 px-3 py-2 font-mono text-[13px] break-all text-muted">{tg}</div>}
            <ReadBody it={it} onEdit={() => setMode("edit")} open={open} />
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 gap-8 px-14 pt-6">
          <div className={cx("mx-auto flex min-h-0 w-full flex-1 flex-col", !full && "max-w-[880px]")}>
            <Editor key={it.id + mode} it={it} rich={mode === "edit"} focusTitle={focusTitle} open={open} />
          </div>

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
      <main className="grid min-w-0 flex-1 place-items-center rounded-[18px] bg-surface p-6 text-center text-sm text-faint">
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
    <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-[18px] bg-surface">
      <ItemView
        it={it}
        mode={ui.mode}
        setMode={ui.setMode}
        wide
        focusTitle={focusTitle}
        open={(id, edit) => {
          const t = data?.items.find((x) => x.id === id);
          if (t && viewOf(t.type) !== ui.view) ui.setView(viewOf(t.type));
          useUi.getState().select(id);
          if (edit && ui.mode === "read") ui.setMode("edit");
        }}
      />
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
      className={cx("fixed top-4 right-4 bottom-4 z-30 flex flex-col overflow-hidden rounded-[18px] bg-surface shadow-3", full && "left-4")}
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
        open={(id, edit) => {
          ui.openPeek(id, edit ? "edit" : "read");
          if (full) useUi.setState({ peekFull: true });
        }}
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
