/* 右下角快速记录：回车记下，Shift+回车换行；支持 #标签 @设备 !1 ~明天，可以直接粘贴截图 */
import { Plus } from "lucide-react";
import { useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { putAsset } from "../lib/api";
import { addItem, useAppState } from "../lib/data";
import { parseCapture } from "../lib/logic";
import { useUi, type View } from "../lib/store";
import { TYPES, typeName, type ItemType } from "../lib/types";
import { cx } from "../lib/cx";

const CAP_TYPES: ItemType[] = ["todo", "issue", "idea", "note", "link"];
const DEFAULT_TYPE: Record<string, ItemType | undefined> = { notes: "note", links: "link", inbox: "inbox" };

export function Capture() {
  const { data } = useAppState();
  const ui = useUi();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  // 在笔记页默认记成笔记、在入口页默认记成入口；事项页用上次选的类型
  const fixed = DEFAULT_TYPE[ui.view];
  const type: ItemType = fixed === "inbox" ? "inbox" : ui.view === "work" ? ui.capType : (fixed ?? ui.capType);

  const grow = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 220) + "px";
  };

  async function submit() {
    const raw = text.trim();
    if (!raw || busy) return;
    const p = parseCapture(raw, type === "inbox" ? "note" : type, data?.devices ?? []);
    if (!p.title) return;
    const tags = [...new Set([...(ui.tag ? [ui.tag] : []), ...p.tags])];
    const category = ui.cat && ui.cat !== "none" ? ui.cat : undefined;
    setBusy(true);
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
      setText("");
      requestAnimationFrame(grow);
      ui.say(`已记为${typeName(type)}`, { label: "查看", run: () => (ui.setView(viewOf(type)), useUi.getState().select(it.id)) });
    } catch {
      /* 失败提示在数据层 */
    } finally {
      setBusy(false);
    }
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  }

  async function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const files = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    e.preventDefault();
    try {
      const names = await Promise.all(files.map(putAsset));
      const md = names.map((n) => `![](asset:${n})`).join("\n");
      // 截图放在正文里：第一行留作标题
      setText((t) => (t.trim() ? t.replace(/\s*$/, "") + "\n" + md : "截图\n" + md));
      requestAnimationFrame(grow);
    } catch (err) {
      ui.say(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section
      aria-label="快速记录"
      className="fixed right-5 bottom-5 z-30 flex w-[min(380px,calc(100vw-40px))] flex-col gap-2 rounded-[18px] border border-line bg-surface py-2.5 pr-2.5 pl-[18px] shadow-3"
    >
      <div className="flex items-end gap-2.5">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          onChange={(e) => (setText(e.target.value), grow())}
          onKeyDown={onKey}
          onPaste={onPaste}
          placeholder={type === "inbox" ? "丢进收件箱，回头再整理…" : "想到什么，直接记下来…"}
          aria-label="快速记录"
          className="scroll-quiet min-w-0 grow resize-none self-center border-none bg-transparent py-1.5 text-[15px] leading-6 text-fg outline-none placeholder:text-faint focus-visible:outline-none"
        />
        <button
          aria-label="记下"
          title="记下（回车）"
          disabled={!text.trim() || busy}
          onClick={submit}
          className="grid size-[38px] shrink-0 place-items-center rounded-xl bg-accent text-on-accent transition-colors hover:bg-accent-strong disabled:opacity-40 [&_svg]:size-[18px]"
        >
          <Plus strokeWidth={2.2} />
        </button>
      </div>
      {type !== "inbox" && (
        <div role="radiogroup" aria-label="记成" className="flex flex-wrap items-center gap-1.5 text-[12.5px]">
          {CAP_TYPES.map((k) => (
            <button
              key={k}
              role="radio"
              aria-checked={type === k}
              onClick={() => {
                ui.setCapType(k);
                if (ui.view !== "work" && fixed !== k) ui.setView(viewOf(k));
                ref.current?.focus();
              }}
              className={cx("rounded-full px-2.5 py-0.5", type === k ? "bg-accent-soft font-semibold text-accent-strong" : "text-muted hover:text-fg")}
            >
              {TYPES.find((t) => t.k === k)?.short ?? typeName(k)}
            </button>
          ))}
          <span className="ml-auto pr-1 text-[11.5px] text-faint">#标签 !1 ~明天</span>
        </div>
      )}
    </section>
  );
}

export const viewOf = (t: ItemType): View => (t === "note" ? "notes" : t === "link" ? "links" : t === "inbox" ? "inbox" : "work");
