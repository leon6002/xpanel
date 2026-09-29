/* 界面状态（不是数据）：当前页、选中的条目、筛选、外观、提示 */
import { create } from "zustand";
import { setWindowTheme } from "./api";
import type { ItemType } from "./types";

export type View = "inbox" | "work" | "notes" | "links" | "rules";
export type Theme = "system" | "light" | "dark";

const ls = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string | null) => {
    try {
      if (v == null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {
      /* 隐私模式等 */
    }
  },
};

export function applyTheme(t: Theme) {
  const dark = t === "dark" || (t === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  setWindowTheme(t === "system" ? null : t);
}

export { ls };

interface Ui {
  view: View;
  selected: Partial<Record<View, string | null>>;
  cat: string | null; // 分类筛选；"none" = 未分类
  tag: string | null;
  dev: string | null; // 按设备筛选
  q: string;
  /** 右侧浮出的阅读面板（在任何页面都能打开任意一条） */
  peek: { id: string; mode: "read" | "edit" } | null;
  peekFull: boolean;
  /** 正在后台问 AI 的问题（按条目） */
  qaPending: Record<string, { q: string; quote: string; agent: string }[]>;
  theme: Theme;
  capType: ItemType;
  mode: "read" | "edit" | "split";
  toast: { text: string; action?: { label: string; run: () => void } } | null;
  setView: (v: View) => void;
  select: (id: string | null) => void;
  setCat: (c: string | null) => void;
  setTag: (t: string | null) => void;
  setQ: (q: string) => void;
  setDev: (d: string | null) => void;
  openPeek: (id: string, mode?: "read" | "edit") => void;
  closePeek: () => void;
  cycleTheme: () => void;
  setCapType: (t: ItemType) => void;
  /** 让快速记录（或收件箱输入框）拿到焦点；可以顺便切换类型 */
  focusCapture: (t?: ItemType) => void;
  capFocus: number;
  /** 收件箱当前的会话："me" = 随手记，其他是导入的聊天 id */
  ibx: string;
  setIbx: (id: string) => void;
  setMode: (m: "read" | "edit" | "split") => void;
  say: (text: string, action?: { label: string; run: () => void }) => void;
}

let toastTimer: number | undefined;
/** 鼠标停在提示上时先别让它消失 */
export function holdToast(hold: boolean) {
  window.clearTimeout(toastTimer);
  if (!hold) toastTimer = window.setTimeout(() => useUi.setState({ toast: null }), 3000);
}

export const useUi = create<Ui>((set, get) => ({
  view: (ls.get("wb-next-view") as View) || "notes",
  selected: {},
  cat: null,
  tag: null,
  dev: null,
  q: "",
  peek: null,
  peekFull: false,
  qaPending: {},
  theme: (ls.get("wb-theme") as Theme) || "system",
  capType: (({ notes: "note", links: "link", rules: "rule" } as Record<string, ItemType>)[ls.get("wb-next-view") || ""] ?? "todo"),
  mode: (ls.get("wb-notemode") as "read" | "edit" | "split") || "read",
  toast: null,
  setView: (view) => {
    ls.set("wb-next-view", view);
    // 快速记录默认记成当前页的类型
    set((s) => ({
      view,
      capType: ({ notes: "note", links: "link", rules: "rule" } as Record<string, ItemType>)[view] ?? (["todo", "issue", "idea"].includes(s.capType) ? s.capType : "todo"),
    }));
  },
  select: (id) => set((s) => ({ selected: { ...s.selected, [s.view]: id } })),
  setCat: (cat) => set({ cat, tag: null }),
  setTag: (tag) => set({ tag }),
  setQ: (q) => set({ q }),
  setDev: (dev) => set({ dev }),
  openPeek: (id, mode = "read") => set({ peek: { id, mode }, peekFull: false }),
  closePeek: () => set({ peek: null, peekFull: false }),
  cycleTheme: () => {
    const order: Theme[] = ["system", "light", "dark"];
    const theme = order[(order.indexOf(get().theme) + 1) % 3];
    ls.set("wb-theme", theme === "system" ? null : theme);
    applyTheme(theme);
    set({ theme });
    get().say(`外观：${{ system: "跟随系统", light: "浅色", dark: "深色" }[theme]}`);
  },
  setCapType: (capType) => set({ capType }),
  capFocus: 0,
  ibx: ls.get("wb-ibx") || "me",
  setIbx: (ibx) => {
    ls.set("wb-ibx", ibx);
    set({ ibx });
  },
  focusCapture: (t) => set((s) => ({ capFocus: s.capFocus + 1, ...(t ? { capType: t } : {}) })),
  setMode: (mode) => {
    ls.set("wb-notemode", mode);
    set({ mode });
  },
  say: (text, action) => {
    window.clearTimeout(toastTimer);
    set({ toast: { text, action } });
    toastTimer = window.setTimeout(() => set({ toast: null }), action ? 10000 : 2400);
  },
}));
