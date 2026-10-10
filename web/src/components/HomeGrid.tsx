/* 首页的模块可以自己摆：按住标题拖动换位置，拖右边 / 左边 / 下边 / 右下角改大小，双击下边恢复成高度跟着内容走。
   布局只记在这台电脑上（各台电脑屏幕不一样）。窄屏时排成一列，不能拖。算法在 lib/grid.ts。 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent, type ReactNode } from "react";
import { cx } from "../lib/cx";
import { COLS, MIN_H, MIN_W, ROW, compact, mergeSlots, place, sameSlots, type Box, type Slot } from "../lib/grid";
import { ls } from "../lib/store";

export interface Tile {
  id: string;
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
  body: ReactNode;
}

/** 模块之间的空隙 */
const GAP = 12;
/** 比这窄就排成一列 */
const NARROW = 720;
type Kind = "move" | "e" | "w" | "s" | "se";
interface Gesture {
  id: string;
  kind: Kind;
  x0: number;
  y0: number;
  /** 开始时页面滚到哪了：拖到边上页面会跟着滚 */
  s0: number;
  dx: number;
  dy: number;
  start: Box;
  /** 按下后动了几个像素才算开始，免得点一下也算拖 */
  active: boolean;
}
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function load(key: string, defaults: Slot[]): Slot[] {
  try {
    return mergeSlots(JSON.parse(ls.get(key) || "null"), defaults);
  } catch {
    return defaults.map((d) => ({ ...d }));
  }
}

const edge = "absolute z-[2] touch-none after:absolute after:rounded-full after:bg-transparent after:transition-colors hover:after:bg-faint";

function TileView({
  tile,
  style,
  lifted,
  animate,
  editable,
  fixed,
  onSize,
  onGrab,
  onAuto,
}: {
  tile: Tile;
  style: CSSProperties;
  lifted: boolean;
  animate: boolean;
  editable: boolean;
  /** 高度是用户定的（不跟着内容） */
  fixed: boolean;
  onSize: (id: string, h: number) => void;
  onGrab: (id: string, kind: Kind, e: RPointerEvent) => void;
  onAuto: (id: string) => void;
}) {
  const inner = useRef<HTMLDivElement>(null);
  // 内容本来有多高：高度跟着内容走的模块按它算
  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    const report = () => onSize(tile.id, Math.ceil(el.offsetHeight));
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tile.id, onSize]);
  const grab = (kind: Kind) => (e: RPointerEvent) => onGrab(tile.id, kind, e);
  return (
    <div data-tile={tile.id} style={style} className={cx("absolute top-0 left-0", animate && "transition-[transform,width,height] duration-150 ease-out", lifted && "z-30")}>
      <section aria-label={tile.title} className={cx("h-full overflow-hidden rounded-[18px] bg-surface", lifted && "shadow-3")}>
        <div className="scroll-quiet h-full overflow-x-hidden overflow-y-auto">
          <div ref={inner} className="flex min-w-0 flex-col gap-1 p-3">
            <h2
              onPointerDown={editable ? grab("move") : undefined}
              title={editable ? "按住拖动换位置" : undefined}
              className={cx("sticky top-0 z-[1] -mx-1 -mt-3 flex items-center gap-2 bg-surface px-3 pt-3.5 pb-1 text-[13px] font-semibold text-fg whitespace-nowrap select-none", editable && (lifted ? "cursor-grabbing" : "cursor-grab"))}
            >
              <span className="shrink-0">{tile.title}</span>
              {tile.hint && <span className="min-w-0 truncate text-xs font-normal text-muted">{tile.hint}</span>}
              <span className="grow" />
              {tile.action}
            </h2>
            {tile.body}
          </div>
        </div>
      </section>
      {editable && (
        <>
          <div aria-hidden onPointerDown={grab("w")} className={cx(edge, "top-4 bottom-4 -left-[5px] w-2.5 cursor-ew-resize after:inset-y-0 after:left-[3px] after:w-1")} />
          <div aria-hidden onPointerDown={grab("e")} className={cx(edge, "top-4 -right-[5px] bottom-4 w-2.5 cursor-ew-resize after:inset-y-0 after:left-[3px] after:w-1")} />
          <div
            role="separator"
            aria-label={"改「" + tile.title + "」的高度"}
            title={fixed ? "拖动改高度；双击恢复成跟着内容走" : "拖动改高度"}
            onPointerDown={grab("s")}
            onDoubleClick={() => onAuto(tile.id)}
            className={cx(edge, "right-4 -bottom-[5px] left-4 h-2.5 cursor-ns-resize after:inset-x-0 after:top-[3px] after:h-1")}
          />
          <div aria-hidden onPointerDown={grab("se")} className="absolute -right-[5px] -bottom-[5px] z-[3] size-4 cursor-nwse-resize touch-none" />
        </>
      )}
    </div>
  );
}

export function HomeGrid({ tiles, defaults, storeKey }: { tiles: Tile[]; defaults: Slot[]; storeKey: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [slots, setSlots] = useState(() => load(storeKey, defaults));
  const [natural, setNatural] = useState<Record<string, number>>({});
  const [g, setG] = useState<Gesture | null>(null);
  const [ready, setReady] = useState(false);

  useLayoutEffect(() => {
    const el = box.current!;
    const read = () => setWidth(el.clientWidth);
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // 第一次摆好之后才开动画，免得一打开就看到模块飞过来
  useEffect(() => {
    if (!width || ready) return;
    const t = requestAnimationFrame(() => requestAnimationFrame(() => setReady(true)));
    return () => cancelAnimationFrame(t);
  }, [width, ready]);
  const onSize = useCallback((id: string, h: number) => setNatural((n) => (n[id] === h ? n : { ...n, [id]: h })), []);

  const save = (next: Slot[]) => {
    setSlots(next);
    ls.set(storeKey, sameSlots(next, defaults) ? null : JSON.stringify(next));
  };

  const stacked = width < NARROW;
  const col = (width + GAP) / COLS;
  const rowsOf = (id: string) => Math.ceil(((natural[id] ?? 160) + GAP) / ROW);
  const visible = slots.filter((s) => tiles.some((t) => t.id === s.id));
  const base = stacked ? compact([...visible].sort((a, b) => a.x - b.x || a.y - b.y).map((s, i) => ({ id: s.id, x: 0, w: COLS, y: i, h: rowsOf(s.id) }))) : compact(visible.map((s) => ({ ...s, h: s.h ?? rowsOf(s.id) })));

  // 正在拖：从拖之前的布局算出现在的样子
  let shown = base;
  const live = g?.active && !stacked ? g : null;
  if (live) {
    const s = live.start;
    if (live.kind === "move") {
      shown = place(base, live.id, {
        x: (s.x * col + live.dx) / col,
        y: (s.y * ROW + live.dy) / ROW,
      });
    } else {
      const to: Partial<Box> = {};
      if (live.kind === "e" || live.kind === "se") to.w = clamp(Math.round((s.w * col + live.dx) / col), MIN_W, COLS - s.x);
      if (live.kind === "w") {
        to.x = clamp(Math.round((s.x * col + live.dx) / col), 0, s.x + s.w - MIN_W);
        to.w = s.x + s.w - to.x;
      }
      if (live.kind === "s" || live.kind === "se") to.h = Math.max(MIN_H, Math.round((s.h * ROW + live.dy) / ROW));
      shown = place(base, live.id, to, false);
    }
  }
  const latest = useRef({ base, shown, slots });
  latest.current = { base, shown, slots };

  const scroller = () => box.current?.closest("main") as HTMLElement | null;
  const onGrab = (id: string, kind: Kind, e: RPointerEvent) => {
    if (e.button !== 0 || stacked) return;
    if (kind === "move" && (e.target as HTMLElement).closest("button, a, input, textarea, [role=checkbox]")) return;
    const start = base.find((b) => b.id === id);
    if (!start) return;
    if (kind !== "move") e.preventDefault();
    setG({
      id,
      kind,
      x0: e.clientX,
      y0: e.clientY,
      s0: scroller()?.scrollTop ?? 0,
      dx: 0,
      dy: 0,
      start,
      active: kind !== "move",
    });
  };
  const onAuto = (id: string) => {
    if (slots.some((s) => s.id === id && s.h !== null)) save(slots.map((s) => (s.id === id ? { ...s, h: null } : s)));
  };

  const cur = useRef(g);
  cur.current = g;
  const busy = !!g;
  const kind = g?.kind;
  useEffect(() => {
    if (!busy) return;
    const sc = scroller();
    const put = (x: Gesture | null) => {
      cur.current = x;
      setG(x);
    };
    let lastX = 0;
    let lastY = 0;
    const follow = () => {
      const x = cur.current;
      if (!x) return;
      const dy = lastY - x.y0 + ((sc?.scrollTop ?? 0) - x.s0);
      put({
        ...x,
        dx: lastX - x.x0,
        dy,
        active: x.active || Math.hypot(lastX - x.x0, lastY - x.y0) > 4,
      });
    };
    const move = (e: PointerEvent) => {
      lastX = e.clientX;
      lastY = e.clientY;
      follow();
    };
    const done = (commit: boolean) => {
      const x = cur.current;
      put(null);
      if (!x?.active || !commit) return;
      const { base, shown, slots } = latest.current;
      const tall = x.kind === "s" || x.kind === "se";
      const moved = shown.some((n) => {
        const o = base.find((b) => b.id === n.id);
        return !o || o.x !== n.x || o.y !== n.y || o.w !== n.w || (tall && n.id === x.id && o.h !== n.h);
      });
      if (!moved) return;
      save(
        slots.map((s) => {
          const n = shown.find((b) => b.id === s.id);
          return n
            ? {
                ...s,
                x: n.x,
                y: n.y,
                w: n.w,
                h: tall && n.id === x.id ? n.h : s.h,
              }
            : s;
        }),
      );
    };
    const up = () => done(true);
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") done(false);
    };
    // 拖到页面上下边缘时跟着滚
    let raf = 0;
    const tick = () => {
      const x = cur.current;
      if (x?.active && sc && (lastX || lastY)) {
        const r = sc.getBoundingClientRect();
        const v = lastY > r.bottom - 48 ? 14 : lastY < r.top + 48 ? -14 : 0;
        const before = sc.scrollTop;
        if (v) sc.scrollTop += v;
        if (sc.scrollTop !== before) follow();
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("keydown", key, true);
    const b = document.body.style;
    const old = [b.userSelect, b.cursor];
    b.userSelect = "none";
    b.cursor = kind === "move" ? "grabbing" : kind === "s" ? "ns-resize" : kind === "se" ? "nwse-resize" : "ew-resize";
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("keydown", key, true);
      [b.userSelect, b.cursor] = old;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, kind]);

  const rows = shown.reduce((m, b) => Math.max(m, b.y + b.h), 0);
  const rect = (b: Box) => ({
    left: b.x * col,
    top: b.y * ROW,
    width: b.w * col - GAP,
    height: b.h * ROW - GAP,
  });
  const ghost = live?.kind === "move" ? shown.find((b) => b.id === live.id) : undefined;
  const custom = !sameSlots(slots, defaults);

  return (
    <>
      <div ref={box} className="relative shrink-0" style={{ height: width ? Math.max(0, rows * ROW - GAP) : undefined }}>
        {width > 0 && ghost && (
          <div
            aria-hidden
            className="absolute top-0 left-0 rounded-[18px] bg-accent-soft transition-[transform,width,height] duration-150 ease-out"
            style={{
              transform: `translate(${rect(ghost).left}px, ${rect(ghost).top}px)`,
              width: rect(ghost).width,
              height: rect(ghost).height,
            }}
          />
        )}
        {width > 0 &&
          tiles.map((t) => {
            const b = shown.find((x) => x.id === t.id);
            if (!b) return null;
            const lifted = !!ghost && ghost.id === t.id;
            const r = rect(lifted ? live!.start : b);
            const left = lifted ? clamp(r.left + live!.dx, 0, Math.max(0, width - r.width)) : r.left;
            const top = lifted ? Math.max(0, r.top + live!.dy) : r.top;
            return (
              <TileView
                key={t.id}
                tile={t}
                style={{
                  transform: `translate(${left}px, ${top}px)`,
                  width: r.width,
                  height: r.height,
                }}
                lifted={lifted}
                animate={ready && !lifted}
                editable={!stacked}
                fixed={slots.some((s) => s.id === t.id && s.h !== null)}
                onSize={onSize}
                onGrab={onGrab}
                onAuto={onAuto}
              />
            );
          })}
      </div>
      {!stacked && width > 0 && (
        <div className="flex shrink-0 items-center justify-end gap-1 px-2 text-xs text-faint">
          <span>按住标题拖动换位置，拖边缘改大小</span>
          {custom && (
            <button className="rounded-lg px-2 py-1 text-muted hover:bg-surface-2 hover:text-fg" onClick={() => save(defaults.map((d) => ({ ...d })))}>
              恢复默认布局
            </button>
          )}
        </div>
      )}
    </>
  );
}
