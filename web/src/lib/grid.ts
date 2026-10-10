/* 首页模块的摆放：一张 12 列的网格，每块有位置和大小（x、w 按列，y、h 按行，一行 ROW 像素）。
   块会自动往上靠，不留空；拖一块压到别的块上，压在上半截就把它挤下去，压在下半截就排到它下面。
   这里只有算法，不碰界面。 */

export const COLS = 12;
/** 一行多高（像素）。高度按它取整，所以拖高度几乎是连续的 */
export const ROW = 8;
export const MIN_W = 3;
export const MIN_H = 8;

/** 算好的一块 */
export interface Box {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
/** 存下来的一块：h 为 null 表示高度跟着内容走 */
export interface Slot {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number | null;
}

const hit = (a: Box, b: Box) => a.id !== b.id && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** 都往上靠：按从上到下的顺序，每块升到碰到别的块为止。first 是正在动的那块，同一行时它优先 */
export function compact(boxes: Box[], first?: string): Box[] {
  const sorted = boxes.map((b) => ({ ...b })).sort((a, b) => a.y - b.y || Number(b.id === first) - Number(a.id === first) || a.x - b.x);
  const out: Box[] = [];
  for (const c of sorted) {
    c.y = Math.max(0, c.y);
    while (c.y > 0 && !out.some((o) => hit({ ...c, y: c.y - 1 }, o))) c.y--;
    for (let o = out.find((o) => hit(c, o)); o; o = out.find((o) => hit(c, o))) c.y = o.y + o.h;
    out.push(c);
  }
  return out;
}

function push(list: Box[], by: Box, depth = 0) {
  if (depth > list.length) return;
  for (const o of list.filter((o) => hit(o, by)).sort((a, b) => a.y - b.y)) {
    o.y = by.y + by.h;
    push(list, o, depth + 1);
  }
}

/** 把一块挪到新位置或改成新大小，别的块让开，再整体往上靠。settle：拖动位置时落在别的块下半截就排到它下面 */
export function place(boxes: Box[], id: string, to: Partial<Box>, settle = true): Box[] {
  const list = boxes.map((b) => (b.id === id ? { ...b, ...to } : { ...b }));
  const me = list.find((b) => b.id === id);
  if (!me) return compact(list);
  me.w = Math.min(COLS, Math.max(MIN_W, Math.round(me.w)));
  me.x = Math.min(COLS - me.w, Math.max(0, Math.round(me.x)));
  me.y = Math.max(0, Math.round(me.y));
  me.h = Math.max(1, Math.round(me.h));
  if (settle) {
    for (let n = 0; n < list.length; n++) {
      const under = list.filter((o) => hit(o, me) && me.y >= o.y + o.h / 2).sort((a, b) => b.y + b.h - (a.y + a.h))[0];
      if (!under) break;
      me.y = under.y + under.h;
    }
  }
  push(list, me);
  return compact(list, id);
}

/** 读回存着的布局：只留认识的块，缺的按默认补上，数字不对的改回默认 */
export function mergeSlots(saved: unknown, defaults: Slot[]): Slot[] {
  const list = Array.isArray(saved) ? saved : [];
  const int = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  return defaults.map((d) => {
    const s = list.find((x) => x && typeof x === "object" && (x as Slot).id === d.id) as Slot | undefined;
    if (!s || !int(s.x) || !int(s.y) || !int(s.w)) return { ...d };
    const w = Math.min(COLS, Math.max(MIN_W, Math.round(s.w)));
    return {
      id: d.id,
      w,
      x: Math.min(COLS - w, Math.max(0, Math.round(s.x))),
      y: Math.max(0, Math.round(s.y)),
      h: int(s.h) ? Math.max(MIN_H, Math.round(s.h as number)) : null,
    };
  });
}

export const sameSlots = (a: Slot[], b: Slot[]) => a.length === b.length && a.every((s, i) => s.id === b[i].id && s.x === b[i].x && s.w === b[i].w && s.h === b[i].h && s.y === b[i].y);
