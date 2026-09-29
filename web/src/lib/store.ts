/* 界面状态（不是数据）：当前页、选中的条目、筛选、外观、提示 */
import { create } from "zustand";
import type { ItemType } from "./types";

export type View = "inbox" | "work" | "notes" | "links";
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
}

interface Ui {
  view: View;
  selected: Partial<Record<View, string | null>>;
  cat: string | null; // 分类筛选；"none" = 未分类
  tag: string | null;
  q: string;
  theme: Theme;
  capType: ItemType;
  mode: "read" | "edit";
  toast: { text: string; action?: { label: string; run: () => void } } | null;
  setView: (v: View) => void;
  select: (id: string | null) => void;
  setCat: (c: string | null) => void;
  setTag: (t: string | null) => void;
  setQ: (q: string) => void;
  cycleTheme: () => void;
  setCapType: (t: ItemType) => void;
  setMode: (m: "read" | "edit") => void;
  say: (text: string, action?: { label: string; run: () => void }) => void;
}

let toastTimer: number | undefined;

export const useUi = create<Ui>((set, get) => ({
  view: (ls.get("wb-next-view") as View) || "notes",
  selected: {},
  cat: null,
  tag: null,
  q: "",
  theme: (ls.get("wb-theme") as Theme) || "system",
  capType: "todo",
  mode: "read",
  toast: null,
  setView: (view) => {
    ls.set("wb-next-view", view);
    set({ view, mode: "read" });
  },
  select: (id) => set((s) => ({ selected: { ...s.selected, [s.view]: id }, mode: "read" })),
  setCat: (cat) => set({ cat, tag: null }),
  setTag: (tag) => set({ tag }),
  setQ: (q) => set({ q }),
  cycleTheme: () => {
    const order: Theme[] = ["system", "light", "dark"];
    const theme = order[(order.indexOf(get().theme) + 1) % 3];
    ls.set("wb-theme", theme === "system" ? null : theme);
    applyTheme(theme);
    set({ theme });
    get().say(`外观：${{ system: "跟随系统", light: "浅色", dark: "深色" }[theme]}`);
  },
  setCapType: (capType) => set({ capType }),
  setMode: (mode) => set({ mode }),
  say: (text, action) => {
    window.clearTimeout(toastTimer);
    set({ toast: { text, action } });
    toastTimer = window.setTimeout(() => set({ toast: null }), action ? 6000 : 2400);
  },
}));
