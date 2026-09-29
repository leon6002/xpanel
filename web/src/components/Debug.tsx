/* 排查用的事件记录：Ctrl+Alt+D 打开 / 关闭，列出最近的鼠标、键盘、焦点事件（平时不显示、不记录） */
import { useEffect, useState } from "react";

const desc = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return String(t);
  const label = el.getAttribute?.("aria-label") || el.getAttribute?.("title") || (el.textContent || "").trim().slice(0, 12);
  return `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}${label ? " «" + label + "»" : ""}`;
};

export function DebugPanel() {
  const [on, setOn] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  useEffect(() => {
    const toggle = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.altKey && e.key.toLowerCase() === "d") setOn((v) => !v);
    };
    window.addEventListener("keydown", toggle);
    return () => window.removeEventListener("keydown", toggle);
  }, []);
  useEffect(() => {
    if (!on) return;
    const t0 = performance.now();
    const rec = (e: Event) => {
      const extra =
        e instanceof KeyboardEvent ? " " + e.key : e instanceof MouseEvent ? ` (${e.clientX},${e.clientY}) btn${e.button}${e.defaultPrevented ? " prevented" : ""}` : "";
      const line = `${((performance.now() - t0) / 1000).toFixed(2)} ${e.type}${extra} → ${desc(e.target)} | active=${desc(document.activeElement)} | body.pe=${document.body.style.pointerEvents || "-"}`;
      setLog((l) => [...l.slice(-15), line]);
    };
    const types = ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "keydown", "keyup", "focusin", "blur"];
    types.forEach((t) => window.addEventListener(t, rec, true));
    return () => types.forEach((t) => window.removeEventListener(t, rec, true));
  }, [on]);
  if (!on) return null;
  return (
    <pre className="pointer-events-none fixed bottom-2 left-2 z-[100] max-w-[70vw] rounded-lg bg-black/85 p-2 font-mono text-[11px] leading-snug whitespace-pre-wrap text-green-300">
      {log.join("\n") || "（等待事件）"}
    </pre>
  );
}
