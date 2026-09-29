/* 基础控件：按钮、标签片、分段切换。外观都来自设计规范的颜色变量 */
import type { ButtonHTMLAttributes, ReactNode } from "react";
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
