/* 右下角快速记录：平时只是一个「+」按钮，点开（或按 /、粘贴截图）才展开输入框。
   回车记下，Shift+回车换行；支持 #标签 @设备 !1 ~明天，截图直接粘贴，文件拖进来。
   有没发出去的草稿时保持展开；空着时点别处或按 Esc 收起。 */
import { Plus } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { addItem, useAppState } from "../lib/data";
import { useDrafts } from "../lib/drafts";
import { assetMd, nowLabel, parseCapture } from "../lib/logic";
import { useUi } from "../lib/store";
import { TYPES, typeName, type ItemType } from "../lib/types";
import { cx } from "../lib/cx";
import { PendingFiles } from "./Files";
import { viewOf } from "./Reader";

const HINT: Partial<Record<ItemType, string>> = {
  note: "随手粘贴一段内容，回车存进「笔记」。支持 Markdown",
  link: "粘贴网址或路径，如 \\\\NAS\\share；想起名字就写在第一行",
};

export function Capture() {
  const { data } = useAppState();
  const ui = useUi();
  const draft = useDrafts((s) => s.capture);
  const d = useDrafts();
  const ref = useRef<HTMLTextAreaElement>(null);
  const box = useRef<HTMLElement>(null);
  const type = ui.capType;
  const [open, setOpen] = useState(false);
  const hasDraft = !!draft.text.trim() || draft.files.length > 0;
  const expanded = open || hasDraft;

  const grow = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 240) + "px";
  };
  useLayoutEffect(grow, [draft.text]);
  useEffect(() => {
    if (ui.capFocus && ui.view !== "inbox") setOpen(true);
  }, [ui.capFocus, ui.view]);
  // 展开后把光标放进去
  useEffect(() => {
    if (expanded) ref.current?.focus();
  }, [expanded, ui.capFocus]);
  // 空着时点别处收起
  useEffect(() => {
    if (!expanded) return;
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (box.current?.contains(t) || (t as HTMLElement).closest?.('[role="dialog"]')) return;
      if (!useDrafts.getState().capture.text.trim() && !useDrafts.getState().capture.files.length) setOpen(false);
    };
    document.addEventListener("mousedown", down);
    return () => document.removeEventListener("mousedown", down);
  }, [expanded]);

  async function submit() {
    const raw = draft.text.trim();
    if (draft.files.some((f) => f.uploading)) return ui.say("截图还在保存，稍等一下");
    const files = draft.files.filter((f) => f.name);
    if (!raw && !files.length) return;
    const p = raw ? parseCapture(raw, type, data?.devices ?? []) : { title: "", body: "", tags: [] as string[], device: "", priority: "" as const, due: "" };
    if (!p.title) {
      if (!files.length) return ui.say("第一行写个标题");
      p.title = (files.some((f) => f.isImg) ? "截图 " : "附件 ") + nowLabel();
    }
    if (type === "note" && p.title.length > 40) {
      p.body = [p.title, p.body].filter(Boolean).join("\n");
      p.title = p.title.slice(0, 30) + "…";
    }
    const att = files.map((f) => assetMd(f.isImg, f.label, f.name!)).join("\n\n");
    if (att) p.body = [p.body, att].filter(Boolean).join("\n\n");
    const tags = [...new Set([...(ui.tag ? [ui.tag] : []), ...p.tags])];
    const category = ui.cat && ui.cat !== "none" ? ui.cat : undefined;
    const keep = { ...draft };
    d.clear("capture");
    setOpen(false);
    try {
      const it = await addItem({
        type,
        title: p.title,
        body: p.body,
        tags,
        device: p.device,
        ...(category ? { category } : {}),
        ...(p.priority ? { priority: p.priority } : {}),
        ...(p.due ? { due: p.due } : {}),
      });
      ui.say(`已记到「${typeName(type)}」` + (files.length ? `，含 ${files.length} 个附件` : ""), {
        label: "查看",
        run: () => {
          useUi.getState().setView(viewOf(type));
          useUi.getState().select(it.id);
        },
      });
    } catch {
      d.restore("capture", keep);
    }
  }

  if (!expanded)
    return (
      <button
        aria-label="快速记录"
        title="快速记录（/）"
        onClick={() => setOpen(true)}
        className="fixed right-6 bottom-6 z-20 grid size-12 place-items-center rounded-full bg-accent text-on-accent shadow-3 transition-transform hover:scale-105 hover:bg-accent-strong [&_svg]:size-[22px]"
      >
        <Plus strokeWidth={2.2} />
      </button>
    );

  return (
    <section
      ref={box}
      aria-label="快速记录"
      className="fixed right-5 bottom-5 z-20 flex w-[min(400px,calc(100vw-40px))] flex-col gap-2 rounded-[18px] bg-surface py-2.5 pr-2.5 pl-[18px] shadow-3"
    >
      <PendingFiles box="capture" />
      <div className="flex items-end gap-2.5">
        <textarea
          ref={ref}
          id="xp-capture"
          rows={1}
          value={draft.text}
          onChange={(e) => d.setText("capture", e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
            if (e.key === "Escape" && !hasDraft) {
              e.preventDefault();
              setOpen(false);
              ref.current?.blur();
            }
          }}
          placeholder="想到什么，直接记下来…"
          aria-label="快速记录"
          className="scroll-quiet min-w-0 grow resize-none self-center border-none bg-transparent py-1.5 text-[15px] leading-6 text-fg outline-none placeholder:text-faint focus-visible:outline-none"
        />
        <button
          aria-label="记下"
          title="记下（回车）"
          disabled={(!draft.text.trim() && !draft.files.length) || draft.files.some((f) => f.uploading)}
          onClick={submit}
          className="grid size-[38px] shrink-0 place-items-center rounded-xl bg-accent text-on-accent transition-colors hover:bg-accent-strong disabled:opacity-40 [&_svg]:size-[18px]"
        >
          <Plus strokeWidth={2.2} />
        </button>
      </div>
      <div role="radiogroup" aria-label="记成" className="flex flex-wrap items-center gap-1 text-[12.5px]">
        {TYPES.map((t, i) => (
          <button
            key={t.k}
            role="radio"
            aria-checked={type === t.k}
            title={`Alt+${i + 1}`}
            onClick={() => {
              ui.setCapType(t.k);
              ref.current?.focus();
            }}
            className={cx("rounded-full px-2.5 py-0.5", type === t.k ? "bg-accent-soft font-semibold text-accent-strong" : "text-muted hover:text-fg")}
          >
            {t.short ?? t.name}
          </button>
        ))}
        <span className="ml-auto truncate pr-1 text-[11.5px] text-faint" title={HINT[type] || "回车保存 · Shift+回车写详情 · #标签 @设备 !1 优先级 ~明天 截止"}>
          {HINT[type] ? (type === "note" ? "Markdown · 截图 Ctrl+V" : "网址或路径") : "#标签 !1 ~明天"}
        </span>
      </div>
    </section>
  );
}
