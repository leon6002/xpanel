/* 平台的 logo（原色）。有图标的画图标；没有的是一个色块加一两个字。
   没认出平台的网站账号用名称的第一个字。行徽多是深色的，深色界面下垫一块白底。数据在 lib/platformData.ts。 */
import type { Platform } from "../lib/platforms";
import { cx } from "../lib/cx";

export function PlatformLogo({ p, size = 18, className }: { p: Platform; size?: number; className?: string }) {
  if (p.parts) {
    return (
      <svg viewBox={p.vb ?? "0 0 24 24"} width={size} height={size} aria-hidden className={cx("shrink-0 text-fg", p.bank && "dark:rounded-[4px] dark:bg-white/90 dark:p-[1.5px]", className)}>
        {p.parts.map(([d, c], i) => (
          <path key={i} d={d} fill={c ? "#" + c : "currentColor"} />
        ))}
      </svg>
    );
  }
  const mark = p.mark ?? p.name.slice(0, 1);
  return (
    <span
      aria-hidden
      className={cx("grid shrink-0 place-items-center rounded-[5px] leading-none font-bold text-white", className)}
      style={{ width: size, height: size, background: "#" + (p.color ?? "888888"), fontSize: size * (mark.length >= 3 ? 0.38 : mark.length === 2 ? 0.48 : 0.62) }}
    >
      {mark}
    </span>
  );
}

/** 没认出平台时：名称的第一个字 */
export function LetterMark({ title, size = 18, className }: { title: string; size?: number; className?: string }) {
  return (
    <span aria-hidden className={cx("grid shrink-0 place-items-center rounded-[5px] bg-surface-3 leading-none font-semibold text-muted", className)} style={{ width: size, height: size, fontSize: size * 0.6 }}>
      {(title.trim()[0] ?? "?").toUpperCase()}
    </span>
  );
}
