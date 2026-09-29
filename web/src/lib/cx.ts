export const cx = (...a: (string | false | null | undefined)[]) => a.filter(Boolean).join(" ");
