/* 基础控件：按钮、标签片、分段切换。外观都来自设计规范的颜色变量 */
import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cx } from "../lib/cx";

type Tone = "primary" | "soft" | "ghost" | "danger";
export function Button({ tone = "soft", className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: Tone }) {
  return (
    <button
      {...p}
      className={cx(
        "inline-flex h-[34px] items-center gap-1.5 whitespace-nowrap rounded-[10px] px-3.5 text-[13px] transition-colors disabled:cursor-default disabled:opacity-50",
        tone === "primary" && "bg-accent font-semibold text-on-accent hover:bg-accent-strong",
        tone === "soft" && "bg-surface-3 text-fg-2 hover:bg-line",
        tone === "ghost" && "bg-transparent text-muted hover:bg-surface-3 hover:text-fg",
        tone === "danger" && "bg-transparent text-danger hover:bg-danger-soft",
        className,
      )}
    />
  );
}

export function IconButton({ label, className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      {...p}
      aria-label={label}
      title={label}
      className={cx("grid size-8 place-items-center rounded-lg text-muted transition-colors hover:bg-surface-3 hover:text-fg [&_svg]:size-[17px]", className)}
    />
  );
}

export function Chip({ children, tone = "plain", className, onClick, title }: { children: ReactNode; tone?: "plain" | "accent" | "warn" | "danger" | "mark"; className?: string; onClick?: () => void; title?: string }) {
  const cls = cx(
    "inline-flex items-center gap-1 whitespace-nowrap rounded-md px-2 text-xs leading-5 [&_svg]:size-3",
    tone === "plain" && "bg-surface-3 text-fg-2",
    tone === "accent" && "bg-accent-soft text-accent-strong",
    tone === "warn" && "bg-warn-soft text-warn-fg",
    tone === "danger" && "bg-danger-soft text-danger",
    tone === "mark" && "bg-mark text-mark-fg",
    onClick && "cursor-pointer hover:brightness-95",
    className,
  );
  return onClick ? (
    <button type="button" className={cls} onClick={onClick} title={title}>
      {children}
    </button>
  ) : (
    <span className={cls} title={title}>
      {children}
    </span>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="flex rounded-[10px] bg-surface-3 p-[3px]">
      {options.map(([k, name]) => (
        <button
          key={k}
          aria-pressed={value === k}
          onClick={() => onChange(k)}
          className={cx(
            "rounded-lg px-3.5 py-1 text-[13px] transition-colors",
            value === k ? "bg-surface font-semibold text-fg shadow-1" : "text-muted hover:text-fg",
          )}
        >
          {name}
        </button>
      ))}
    </div>
  );
}

export const PRI_TONE: Record<string, string> = {
  P0: "bg-danger-soft text-danger",
  P1: "bg-warn-soft text-warn-fg",
  P2: "bg-accent-soft text-accent-strong",
  P3: "bg-surface-3 text-muted",
};
export function Pri({ p }: { p?: string }) {
  if (!p) return null;
  return <span className={cx("mr-1.5 inline-block rounded px-1.5 align-[1px] text-[11px] font-bold leading-[17px]", PRI_TONE[p])}>{p}</span>;
}

/* ---- 表单 ---- */
export const inputCls =
  "h-9 w-full min-w-0 rounded-[10px] border border-line bg-surface px-3 text-[13.5px] text-fg outline-none placeholder:text-faint focus:border-accent focus:ring-2 focus:ring-accent/20";
export const textareaCls =
  "w-full min-w-0 rounded-[10px] border border-line bg-surface px-3 py-2 text-[13.5px] leading-relaxed text-fg outline-none placeholder:text-faint focus:border-accent focus:ring-2 focus:ring-accent/20";

export function Field({ label, children, className, hint }: { label: ReactNode; children: ReactNode; className?: string; hint?: ReactNode }) {
  return (
    <label className={cx("flex min-w-0 flex-col gap-1.5 text-[12.5px] text-muted", className)}>
      <span>{label}</span>
      {children}
      {hint && <span className="text-xs text-faint">{hint}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className="inline-flex cursor-pointer items-start gap-2 text-[13px] text-fg-2">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 size-4 shrink-0 accent-[var(--accent)]" />
      <span className="flex flex-col gap-0.5">{children}</span>
    </label>
  );
}

export function ErrorText({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return <div className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">{children}</div>;
}

/** 选一个 AI（按钮组） */
export function Pick<T>({ items, value, onChange, label, render }: { items: T[]; value: number; onChange: (i: number) => void; label: string; render: (t: T) => ReactNode }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-2">
      {items.map((t, i) => (
        <button
          key={i}
          role="radio"
          aria-checked={i === value}
          onClick={() => onChange(i)}
          className={cx(
            "inline-flex h-9 items-center gap-1.5 rounded-[10px] border px-3.5 text-[13px] transition-colors [&_svg]:size-4",
            i === value ? "border-accent bg-accent-soft font-semibold text-accent-strong" : "border-line text-fg-2 hover:border-faint",
          )}
        >
          {render(t)}
        </button>
      ))}
    </div>
  );
}

/** 需要点两次的危险按钮 */
export function ConfirmButton({ children, confirm, onConfirm, className, tone = "danger" }: { children: ReactNode; confirm: ReactNode; onConfirm: () => void; className?: string; tone?: Tone }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = window.setTimeout(() => setArmed(false), 4000);
    return () => window.clearTimeout(t);
  }, [armed]);
  return (
    <Button tone={tone} className={cx(armed && "bg-danger-soft", className)} onClick={() => (armed ? (setArmed(false), onConfirm()) : setArmed(true))}>
      {armed ? confirm : children}
    </Button>
  );
}
