/* 待发送的截图和附件（快速记录、收件箱输入框共用） */
import { X } from "lucide-react";
import { useState } from "react";
import { useDrafts, type Box } from "../lib/drafts";
import { cx } from "../lib/cx";
import { Lightbox, useAssetUrl } from "./Markdown";

function FileChip({ box, f }: { box: Box; f: ReturnType<typeof useDrafts.getState>["capture"]["files"][number] }) {
  const remove = useDrafts((s) => s.removeFile);
  const saved = useAssetUrl(f.isImg && !f.url && f.name ? f.name : null);
  const src = f.url || saved;
  const [big, setBig] = useState(false);
  return (
    <div className={cx("group relative h-14 overflow-hidden rounded-lg border border-line bg-surface-2", f.uploading && "opacity-60")} title={f.label}>
      {f.isImg ? (
        src ? (
          <img src={src} alt={f.label} className="h-full w-auto max-w-[120px] cursor-zoom-in object-cover" onClick={() => setBig(true)} />
        ) : (
          <span className="block h-full w-16" />
        )
      ) : (
        <span className="flex h-full max-w-[160px] items-center truncate px-2.5 text-xs text-fg-2">📎 {f.label}</span>
      )}
      {f.uploading && <span className="absolute inset-x-0 bottom-0 bg-surface/80 text-center text-[10px] text-muted">保存中…</span>}
      <button
        aria-label="移除"
        title="移除"
        onClick={() => remove(box, f.id)}
        className="absolute top-0.5 right-0.5 grid size-5 place-items-center rounded-full bg-fg/70 text-bg opacity-0 group-hover:opacity-100 [&_svg]:size-3"
      >
        <X />
      </button>
      {big && src && <Lightbox src={src} onClose={() => setBig(false)} />}
    </div>
  );
}

export function PendingFiles({ box }: { box: Box }) {
  const files = useDrafts((s) => s[box].files);
  if (!files.length) return null;
  return (
    <div className="flex flex-wrap gap-2" aria-label="待保存的截图和附件">
      {files.map((f) => (
        <FileChip key={f.id} box={box} f={f} />
      ))}
    </div>
  );
}
