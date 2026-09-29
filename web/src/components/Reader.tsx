import { Folder, Pin, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { putAsset } from "../lib/api";
import { patchItem, removeItem, useAppState } from "../lib/data";
import { allCats, dueInfo, normCat, noteTitle } from "../lib/logic";
import { useUi } from "../lib/store";
import type { Item, ItemType, Priority } from "../lib/types";
import { TYPES, isCheckable, typeName } from "../lib/types";
import { cx } from "../lib/cx";
import { Md } from "./Markdown";
import { Button, Chip, IconButton, Segmented } from "./ui";

const STATUS: Record<string, [string, "warn" | "accent" | "danger"]> = { working: ["进行中", "warn"], done: ["完成", "accent"], blocked: ["卡住了", "danger"] };

function Meta({ it }: { it: Item }) {
  const ui = useUi();
  const di = dueInfo(it);
  const p = (it.agentProgress || []).slice(-1)[0];
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Chip tone="accent">{typeName(it.type)}</Chip>
      {it.category && (
        <Chip onClick={() => ui.setCat(it.category!)} title="只看这个分类">
          {it.category.replace(/\//g, " / ")}
        </Chip>
      )}
      {it.priority && !it.done && <Chip tone={it.priority === "P0" ? "danger" : it.priority === "P1" ? "warn" : "plain"}>{it.priority}</Chip>}
      {di && <Chip tone={di.tone === "late" ? "danger" : di.tone === "soon" ? "warn" : "plain"}>{di.text}</Chip>}
      {(it.tags || []).map((t) => (
        <Chip key={t} onClick={() => ui.setTag(t)}>
          #{t}
        </Chip>
      ))}
      {it.device && <Chip>{it.device}</Chip>}
      {(it.workspaces || []).map((w) => (
        <Chip key={w.path} title={w.path}>
          <Folder /> {w.name}
        </Chip>
      ))}
      {p && <Chip tone={STATUS[p.status]?.[1] ?? "warn"}>AI {STATUS[p.status]?.[0] ?? p.status}</Chip>}
    </div>
  );
}

function QaAside({ it }: { it: Item }) {
  const list = (it.qa || []).slice().reverse();
  if (!list.length) return null;
  return (
    <aside aria-label="问答" className="flex w-[240px] shrink-0 flex-col gap-3 pt-[76px]">
      {list.map((q) => (
        <div key={q.id} className="flex flex-col gap-2 rounded-[14px] bg-surface-2 p-3.5">
          <div className="flex items-center gap-1.5 text-xs text-muted">
            <span className="max-w-[150px] truncate rounded bg-mark px-1.5 text-mark-fg">{q.quote || "整篇笔记"}</span>
            <span>的问答</span>
          </div>
          {q.turns.map((t, i) => (
            <div key={i} className={cx("flex flex-col gap-1", i > 0 && "border-t border-dashed border-line pt-2")}>
              <div className="text-[13.5px] font-semibold text-fg">{t.q}</div>
              <Md src={t.a} className="!text-[13px] !leading-[1.75]" />
              <div className="text-xs text-faint">{t.by}</div>
            </div>
          ))}
        </div>
      ))}
    </aside>
  );
}

function ProgressList({ it }: { it: Item }) {
  const list = (it.agentProgress || []).slice().reverse();
  if (!list.length) return null;
  return (
    <section className="mt-8 border-t border-line pt-4">
      <h3 className="mb-3 text-sm font-semibold text-muted">AI 进展</h3>
      <div className="flex flex-col gap-3">
        {list.map((p, i) => (
          <div key={i} className="rounded-xl bg-surface-2 px-3.5 py-2.5">
            <div className="mb-1 flex items-center gap-2 text-xs text-faint">
              <Chip tone={STATUS[p.status]?.[1] ?? "warn"}>{STATUS[p.status]?.[0] ?? p.status}</Chip>
              <span>{p.by}</span>
              <span>{new Date(p.at).toLocaleString()}</span>
            </div>
            <Md src={p.text} className="!text-[13.5px]" />
            {(p.files || []).length > 0 && <div className="mt-1 flex flex-wrap gap-1.5 font-mono text-xs text-muted">{p.files!.map((f) => <code key={f}>{f}</code>)}</div>}
          </div>
        ))}
      </div>
    </section>
  );
}

/** 编辑：标题、正文（自动保存，截图直接粘贴）、分类 / 标签 / 优先级 / 截止日期 */
function Editor({ it }: { it: Item }) {
  const { data } = useAppState();
  const [title, setTitle] = useState(it.title);
  const [body, setBody] = useState(it.body || "");
  const [saved, setSaved] = useState("已保存");
  const timer = useRef<number | undefined>(undefined);
  const latest = useRef({ title, body });
  latest.current = { title, body };
  const ta = useRef<HTMLTextAreaElement>(null);

  const flush = () => {
    window.clearTimeout(timer.current);
    const { title: t, body: b } = latest.current;
    const cur = data?.items.find((x) => x.id === it.id) ?? it;
    if (t === cur.title && b === (cur.body || "")) return;
    patchItem(cur, { title: t, body: b }).then(() => setSaved("已保存"), () => setSaved("保存失败"));
  };
  const schedule = () => {
    setSaved("正在保存…");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, 700);
  };
  useEffect(() => () => flush(), []); // 离开时保存
  // eslint-disable-next-line react-hooks/exhaustive-deps

  const onPaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    const el = e.currentTarget;
    for (const f of files) {
      const img = /^image\//.test(f.type);
      try {
        const name = await putAsset(f);
        const md = img ? `![截图](asset:${name})` : `[📎 ${f.name}](asset:${name})`;
        const s = el.selectionStart, en = el.selectionEnd;
        const v = el.value.slice(0, s) + md + el.value.slice(en);
        setBody(v);
        schedule();
      } catch (x) {
        useUi.getState().say("保存失败：" + (x instanceof Error ? x.message : String(x)));
      }
    }
  };

  const cats = allCats(data?.items ?? [], data?.categories ?? []);
  const set = (ch: Partial<Item>) => patchItem(data?.items.find((x) => x.id === it.id) ?? it, ch);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <input
        value={title}
        onChange={(e) => {
          setTitle(e.target.value);
          schedule();
        }}
        onBlur={flush}
        placeholder={it.type === "note" ? noteTitle({ ...it, title: "" }) : "标题"}
        className="bg-transparent text-[26px] font-bold text-fg outline-none placeholder:text-faint"
        aria-label="标题"
      />
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <input
          list="xp-cats"
          defaultValue={it.category || ""}
          onBlur={(e) => normCat(e.target.value) !== (it.category || "") && set({ category: normCat(e.target.value) || undefined })}
          placeholder="分类，如 工作/AutoSAR"
          className="h-8 w-48 rounded-lg bg-surface-2 px-2.5 outline-none focus:ring-2 focus:ring-accent/40"
          aria-label="分类"
        />
        <datalist id="xp-cats">{cats.map((c) => <option key={c} value={c} />)}</datalist>
        <input
          defaultValue={(it.tags || []).join(" ")}
          onBlur={(e) => {
            const tags = e.target.value.split(/[\s,，]+/).map((s) => s.replace(/^#/, "")).filter(Boolean);
            if (tags.join(" ") !== (it.tags || []).join(" ")) set({ tags });
          }}
          placeholder="标签，空格分隔"
          className="h-8 w-44 rounded-lg bg-surface-2 px-2.5 outline-none focus:ring-2 focus:ring-accent/40"
          aria-label="标签"
        />
        {isCheckable(it.type) && (
          <>
            <select
              value={it.priority || ""}
              onChange={(e) => set({ priority: (e.target.value || undefined) as Priority | undefined })}
              className="h-8 rounded-lg bg-surface-2 px-2 outline-none"
              aria-label="优先级"
            >
              <option value="">无优先级</option>
              <option value="P0">P0 紧急</option>
              <option value="P1">P1 高</option>
              <option value="P2">P2 中</option>
              <option value="P3">P3 低</option>
            </select>
            <input type="date" value={it.due || ""} onChange={(e) => set({ due: e.target.value || undefined })} className="h-8 rounded-lg bg-surface-2 px-2 outline-none" aria-label="截止日期" />
          </>
        )}
        <span className="ml-auto text-xs text-faint">{saved}</span>
      </div>
      <textarea
        ref={ta}
        value={body}
        onChange={(e) => {
          setBody(e.target.value);
          schedule();
        }}
        onBlur={flush}
        onPaste={onPaste}
        placeholder="支持 Markdown：# 标题、- 列表、- [ ] 待办、`代码`、表格…  截图可以直接粘贴"
        className="min-h-0 flex-1 resize-none rounded-xl bg-surface-2 px-4 pt-4 pb-28 font-mono text-[13.5px] leading-[1.8] text-fg outline-none focus:ring-2 focus:ring-accent/30"
        aria-label="正文"
      />
    </div>
  );
}

export function Reader() {
  const { data } = useAppState();
  const ui = useUi();
  const id = ui.selected[ui.view];
  const it = id ? data?.items.find((x) => x.id === id) : undefined;
  const [armed, setArmed] = useState(false);
  useEffect(() => setArmed(false), [id]);

  if (!it)
    return (
      <main className="grid flex-1 place-items-center rounded-[18px] bg-surface text-sm text-faint shadow-2">
        {ui.view === "inbox" ? "收件箱还在迁移，先在旧界面里用" : "从左边选一条"}
      </main>
    );

  return (
    <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-[18px] bg-surface shadow-2">
      <div className="flex items-center gap-2.5 border-b border-line-soft px-6 py-4">
        <Segmented
          label="显示方式"
          value={ui.mode}
          onChange={ui.setMode}
          options={[
            ["read", "阅读"],
            ["edit", "编辑"],
          ]}
        />
        <span className="grow" />
        {isCheckable(it.type) && (
          <Button tone={it.done ? "soft" : "primary"} onClick={() => patchItem(it, { done: !it.done })}>
            {it.done ? "取消完成" : TYPES.find((t) => t.k === it.type)?.check}
          </Button>
        )}
        <select
          value={it.type}
          onChange={(e) => {
            patchItem(it, { type: e.target.value as ItemType });
            ui.say(`已归类到「${typeName(e.target.value as ItemType)}」`);
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
        <IconButton label={it.pinned ? "取消置顶" : "置顶 / 设为焦点"} onClick={() => patchItem(it, { pinned: !it.pinned })} className={it.pinned ? "text-accent" : ""}>
          <Pin />
        </IconButton>
        <IconButton
          label={armed ? "再点一次删除" : "删除"}
          className={armed ? "bg-danger-soft text-danger" : ""}
          onClick={async () => {
            if (!armed) return setArmed(true);
            await removeItem(it.id);
            ui.select(null);
            ui.say("已删除");
          }}
        >
          <Trash2 />
        </IconButton>
      </div>
      {ui.mode === "edit" ? (
        <div className="flex min-h-0 flex-1 flex-col px-10 py-6">
          <Editor key={it.id} it={it} />
        </div>
      ) : (
        <div className="scroll-quiet flex min-h-0 flex-1 gap-7 overflow-y-auto px-10 pb-40 pt-7">
          <article className="min-w-0 max-w-[680px] flex-1" onDoubleClick={() => ui.setMode("edit")}>
            <Meta it={it} />
            <h2 className="mb-4 mt-3 text-[28px] font-bold leading-snug text-fg">{it.type === "note" ? noteTitle(it) : it.title}</h2>
            {it.body ? <Md src={it.body} /> : <p className="text-faint">没有正文，双击或点「编辑」开始写。</p>}
            <ProgressList it={it} />
          </article>
          <QaAside it={it} />
        </div>
      )}
    </main>
  );
}
