/* 关联：阅读区里的「关联」一节，和选择关联对象的对话框 */
import { FileUp, Link2, Plus, Search, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { errText, putAsset } from "../lib/api";
import { addItem, useAppState } from "../lib/data";
import { Dialog, openDialog } from "../lib/dialog";
import { LABELS, addLink, relatedOf, removeLink, setLabel, type Related } from "../lib/links";
import { entryTarget, fileLabel, isImgFile, noteTitle, plain } from "../lib/logic";
import { useUi } from "../lib/store";
import type { Item } from "../lib/types";
import { typeName } from "../lib/types";
import { cx } from "../lib/cx";
import { Button, inputCls } from "./ui";

const say = (t: string, a?: { label: string; run: () => void }) => useUi.getState().say(t, a);
const titleOf = (x: Item) => (x.type === "note" ? noteTitle(x) : x.title || "(无标题)");

function useItems() {
  return useAppState().data?.items ?? [];
}

/** 标签：点一下改（常用的直接选，也可以自己写） */
function LabelPick({ value, onChange }: { value?: string; onChange: (v: string) => void }) {
  const [edit, setEdit] = useState(false);
  const [v, setV] = useState(value || "");
  if (edit)
    return (
      <span className="relative" onClick={(e) => e.stopPropagation()}>
        <input
          autoFocus
          value={v}
          list="xp-link-labels"
          onChange={(e) => setV(e.target.value)}
          onBlur={() => {
            setEdit(false);
            if (v.trim() !== (value || "")) onChange(v.trim());
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") {
              setV(value || "");
              setEdit(false);
            }
          }}
          placeholder="标签"
          className="h-6 w-20 rounded-md bg-surface-3 px-1.5 text-xs outline-none"
        />
      </span>
    );
  return (
    <button
      title="改标签"
      onClick={(e) => {
        e.stopPropagation();
        setV(value || "");
        setEdit(true);
      }}
      className={cx("h-6 shrink-0 rounded-md px-1.5 text-xs", value ? "bg-accent-soft text-accent-strong" : "text-faint hover:bg-surface-3 hover:text-fg")}
    >
      {value || "+ 标签"}
    </button>
  );
}

/** 正文下面的「关联」 */
export function RelatedSection({ it }: { it: Item }) {
  const items = useItems();
  const list = useMemo(() => relatedOf(items, it), [items, it]);
  const open = (x: Item) => useUi.getState().openPeek(x.id);
  return (
    <section className="mt-12 flex flex-col gap-1" aria-label="关联" data-qa-skip>
      <datalist id="xp-link-labels">
        {LABELS.map((l) => (
          <option key={l} value={l} />
        ))}
      </datalist>
      <h3 className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-muted">
        <Link2 className="size-4" /> 关联 <span className="font-normal text-faint">{list.length || ""}</span>
        <span className="grow" />
        <Button tone="ghost" className="h-7 px-2 text-xs" onClick={() => openLinkPicker(it)}>
          <Plus className="size-3.5" />
          关联
        </Button>
      </h3>
      {!list.length && <p className="text-xs text-faint">把相关的岗位、简历、题库、流程、工具等关联起来；在评论里 @AI 时，AI 会一起读这些内容（包括里面的图片和附件）。</p>}
      {list.map((r) => (
        <RelatedRow key={r.item.id} it={it} r={r} onOpen={() => open(r.item)} />
      ))}
    </section>
  );
}

function RelatedRow({ it, r, onOpen }: { it: Item; r: Related; onOpen: () => void }) {
  const x = r.item;
  const snip = plain((x.type === "link" ? entryTarget(x) || "" : "") || (x.body || "").replace(/!\[[^\]]*\]\([^)]*\)/g, "")).slice(0, 80);
  return (
    <div role="button" tabIndex={0} onClick={onOpen} onKeyDown={(e) => e.key === "Enter" && onOpen()} className="group/rel flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-surface-2">
      <LabelPick value={r.label} onChange={(v) => setLabel(it, r, v).catch(() => {})} />
      <span className="shrink-0 text-[14px] font-medium text-fg">{titleOf(x)}</span>
      <span className="min-w-0 grow truncate text-[13px] text-faint">{snip !== titleOf(x) ? snip : ""}</span>
      <span className="shrink-0 text-xs text-faint">{r.dir === "ref" ? "正文里引用" : r.dir === "in" ? `${typeName(x.type)} · 关联了这条` : typeName(x.type)}</span>
      {r.dir !== "ref" && (
        <button
          title="取消关联"
          aria-label="取消关联"
          onClick={(e) => {
            e.stopPropagation();
            removeLink(it, x).then(() => say("已取消关联", { label: "撤销", run: () => void addLink(r.dir === "in" ? x : it, r.dir === "in" ? it.id : x.id, r.label) }));
          }}
          className="grid size-6 shrink-0 place-items-center rounded-md text-faint opacity-0 group-hover/rel:opacity-100 hover:bg-surface-3 hover:text-fg [&_svg]:size-3.5"
        >
          <X />
        </button>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- 选择关联对象 */

export function openLinkPicker(it: Item) {
  openDialog((close) => <LinkPicker it={it} close={close} />);
}

function LinkPicker({ it, close }: { it: Item; close: () => void }) {
  const items = useItems();
  const [q, setQ] = useState("");
  const [label, setLbl] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const linked = useMemo(() => new Set(relatedOf(items, it).map((r) => r.item.id)), [items, it]);
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const pool = items
    .filter((x) => x.id !== it.id && x.type !== "inbox")
    .filter((x) => !words.length || words.every((w) => `${titleOf(x)}\n${x.body || ""}\n${(x.tags || []).join(" ")}`.toLowerCase().includes(w)))
    .sort((a, b) => Number(linked.has(a.id)) - Number(linked.has(b.id)) || b.updatedAt - a.updatedAt)
    .slice(0, 60);
  const pick = async (x: Item) => {
    close();
    await addLink(it, x.id, label || undefined).catch(() => {});
    say(`已关联「${titleOf(x)}」`);
  };
  const createNote = async () => {
    const n = await addItem({ type: "note", title: q.trim(), body: "", category: it.category || undefined, tags: [] }).catch(() => null);
    if (!n) return;
    await pick(n);
    useUi.getState().openPeek(n.id, "edit");
  };
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    close();
    for (const f of Array.from(files)) {
      try {
        const name = await putAsset(f);
        const body = isImgFile(f) ? `![${fileLabel(f)}](asset:${name})` : `[📎 ${fileLabel(f)}](asset:${name})`;
        const n = await addItem({ type: "note", title: fileLabel(f).replace(/\.[^.]+$/, ""), body, category: it.category || undefined, tags: [] });
        await addLink(it, n.id, label || undefined);
        say(`「${fileLabel(f)}」已保存并关联`);
      } catch (e) {
        say("保存失败：" + errText(e));
      }
    }
  };
  return (
    <Dialog title="关联" desc={`把其他条目关联到「${titleOf(it)}」。标签可以不填，AI 读的时候会看到。`} onClose={close}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-muted">标签</span>
        {LABELS.map((l) => (
          <button key={l} onClick={() => setLbl(label === l ? "" : l)} className={cx("h-7 rounded-full px-2.5 text-xs", label === l ? "bg-ink text-on-ink" : "bg-surface-2 text-fg-2 hover:bg-surface-3")}>
            {l}
          </button>
        ))}
        <input value={LABELS.includes(label) ? "" : label} onChange={(e) => setLbl(e.target.value)} placeholder="其他…" className="h-7 w-20 rounded-full bg-surface-2 px-2.5 text-xs outline-none placeholder:text-faint focus:bg-surface-3" />
      </div>
      <label className={cx(inputCls, "flex items-center gap-2")}>
        <Search className="size-4 text-faint" />
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索标题或内容" className="min-w-0 grow bg-transparent outline-none" aria-label="搜索" />
      </label>
      <div className="-mx-2 flex max-h-[46vh] flex-col overflow-y-auto">
        {pool.map((x) => (
          <button key={x.id} onClick={() => pick(x)} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-surface-2">
            <span className="w-12 shrink-0 text-xs text-faint">{typeName(x.type)}</span>
            <span className="min-w-0 grow truncate text-[13.5px] text-fg">{titleOf(x)}</span>
            {linked.has(x.id) && <span className="shrink-0 text-xs text-faint">已关联</span>}
          </button>
        ))}
        {!pool.length && <div className="px-2 py-4 text-center text-xs text-faint">没有找到</div>}
      </div>
      <div className="flex flex-wrap gap-2">
        {q.trim() && (
          <Button tone="soft" onClick={createNote}>
            <Plus className="size-4" />
            新建笔记「{q.trim().slice(0, 16)}」并关联
          </Button>
        )}
        <Button tone="soft" onClick={() => file.current?.click()} title="比如简历 PDF：保存成一篇笔记并关联">
          <FileUp className="size-4" />
          上传文件并关联
        </Button>
        <input ref={file} type="file" multiple hidden onChange={(e) => upload(e.target.files)} />
      </div>
    </Dialog>
  );
}
