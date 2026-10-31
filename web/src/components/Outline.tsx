/* 笔记的目录：把正文里的标题列出来，点一下跳到那一节（阅读和编辑时都能用）。
   只有两个以上标题时才出现，短笔记不占位置。 */
import * as DM from "@radix-ui/react-dropdown-menu";
import { ListTree } from "lucide-react";
import { useMemo, useState, type RefObject } from "react";
import { IconButton } from "./ui";

type Heading = { level: number; text: string; el: HTMLElement };

/** 正文里有几个标题（代码块里的 # 不算） */
function headingLines(body: string) {
  let fenced = false;
  let n = 0;
  for (const line of body.split("\n")) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (!fenced && /^#{1,4}\s+\S/.test(line)) n++;
  }
  return n;
}

export function OutlineButton({
  body,
  mode,
  readRef,
  editRef,
}: {
  body: string;
  mode: "read" | "edit";
  readRef: RefObject<HTMLDivElement | null>;
  editRef: RefObject<HTMLDivElement | null>;
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Heading[]>([]);
  const enough = useMemo(() => headingLines(body) >= 2, [body]);
  if (!enough) return null;

  const load = () => {
    const root = mode === "read" ? readRef.current : editRef.current;
    const selector = mode === "read" ? "article h1, article h2, article h3, article h4" : ".ProseMirror h1, .ProseMirror h2, .ProseMirror h3, .ProseMirror h4";
    const found = root ? Array.from(root.querySelectorAll<HTMLElement>(selector)) : [];
    setItems(found.map((el) => ({ level: Number(el.tagName.slice(1)), text: (el.textContent || "").trim(), el })));
  };

  const jump = (el: HTMLElement) => {
    const scroller = mode === "read" ? readRef.current : editRef.current;
    if (!scroller) return el.scrollIntoView({ behavior: "smooth", block: "start" });
    const er = el.getBoundingClientRect();
    const cr = scroller.getBoundingClientRect();
    scroller.scrollTo({ top: scroller.scrollTop + er.top - cr.top - 12, behavior: "smooth" });
  };

  return (
    <DM.Root
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (v) load();
      }}
    >
      <DM.Trigger asChild>
        <IconButton label="目录（按标题跳）">
          <ListTree />
        </IconButton>
      </DM.Trigger>
      <DM.Portal>
        <DM.Content align="end" sideOffset={6} className="scroll-quiet z-50 max-h-[60vh] w-64 overflow-y-auto rounded-xl bg-surface p-1 shadow-3">
          <div className="px-2.5 pt-1 pb-1.5 text-[11px] text-faint">目录 · {items.length} 个标题</div>
          {items.map((h, i) => (
            <DM.Item
              key={i}
              onSelect={() => jump(h.el)}
              className="flex cursor-pointer items-baseline gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-fg-2 outline-none data-[highlighted]:bg-surface-2 data-[highlighted]:text-fg"
              style={{ paddingLeft: 10 + (h.level - 1) * 12 }}
            >
              <span className="min-w-0 truncate">{h.text || "（空标题）"}</span>
            </DM.Item>
          ))}
          {!items.length && <div className="px-2.5 py-2 text-xs text-faint">还没有标题</div>}
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}
