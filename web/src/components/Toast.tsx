/* 底部居中的小提示，可带一个操作（撤销、查看…） */
import { holdToast, useUi } from "../lib/store";

export function Toast() {
  const toast = useUi((s) => s.toast);
  if (!toast) return null;
  return (
    <div role="status" aria-live="polite" onMouseEnter={() => holdToast(true)} onMouseLeave={() => holdToast(false)} className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-xl bg-fg px-4 py-2.5 text-[13px] text-bg shadow-3">
      <span>{toast.text}</span>
      {toast.action && (
        <button
          className="font-semibold text-accent-soft underline-offset-2 hover:underline"
          onClick={() => {
            toast.action!.run();
            useUi.setState({ toast: null });
          }}
        >
          {toast.action.label}
        </button>
      )}
    </div>
  );
}
