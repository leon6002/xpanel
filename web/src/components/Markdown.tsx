/* Markdown 阅读：附件图片、图片大小（|480）、看大图、问答原文高亮 */
import { createContext, memo, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import Markdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { assetSrc, copyText, isApp, openTarget } from "../lib/api";
import { useUi } from "../lib/store";
import { useConfig } from "../lib/data";
import { rehypeImgIndex, rehypePaths, rehypeQaMarks } from "../lib/qa";
import type { Qa } from "../lib/types";
import { cx } from "../lib/cx";

/** 有这个就能在图片上改大小（传入的是：第几张图，新宽度；0 = 默认） */
const ImgEdit = createContext<((idx: number, w: number) => void) | null>(null);
/** 点原文高亮时 */
const MarkClick = createContext<((id: string) => void) | null>(null);

export function useAssetUrl(name: string | null) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    if (!name) return;
    assetSrc(name).then((u) => alive && setUrl(u)).catch(() => alive && setUrl(null));
    return () => {
      alive = false;
    };
  }, [name]);
  return url;
}

export function Lightbox({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), onClose());
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [onClose]);
  return createPortal(
    <div className="fixed inset-0 z-50 grid cursor-zoom-out place-items-center bg-black/80 p-6" onClick={onClose}>
      <img src={src} alt="" className="max-h-[92vh] max-w-[94vw] rounded-lg shadow-3" />
    </div>,
    document.body,
  );
}

const SIZES: [string, number][] = [
  ["小", 240],
  ["中", 480],
  ["大", 800],
  ["自动", 0],
];

/** 正文里的附件写成 asset:名字；图片说明末尾的 |480 是显示宽度（和 Obsidian 一样） */
function AssetImg(props: { src?: string; alt?: string; "data-idx"?: number | string }) {
  const { src, alt } = props;
  const idx = props["data-idx"] == null ? -1 : +props["data-idx"];
  const edit = useContext(ImgEdit);
  const m = String(alt || "").match(/^(.*?)\|(\d{2,4})$/);
  const label = m ? m[1] : alt || "";
  const width = m ? +m[2] : 0;
  const s = String(src || "");
  const asset = useAssetUrl(s.startsWith("asset:") ? s.slice(6) : null);
  const url = s.startsWith("asset:") ? asset : s;
  const [big, setBig] = useState(false);
  const [drag, setDrag] = useState<number | null>(null);
  const box = useRef<HTMLSpanElement>(null);
  if (!url) return <span className="inline-block rounded-lg bg-surface-2 px-2 text-xs text-faint">{label || "图片"}</span>;
  const w = drag ?? width;
  const img = <img src={url} alt={label} style={w ? { width: w } : undefined} onClick={() => setBig(true)} />;
  return (
    <>
      {edit && idx >= 0 ? (
        <span ref={box} className="group/img relative inline-block max-w-full align-top" data-qa-skip>
          {img}
          <span className="absolute top-2 right-2 hidden gap-0.5 rounded-lg bg-surface/95 p-0.5 text-xs shadow-2 group-hover/img:flex">
            {SIZES.map(([n, v]) => (
              <button
                key={n}
                title={v ? `宽 ${v}px` : "默认大小"}
                aria-pressed={v === width}
                onClick={() => edit(idx, v)}
                className={cx("rounded-md px-2 py-0.5", v === width ? "bg-accent text-on-accent" : "text-fg-2 hover:bg-surface-3")}
              >
                {n}
              </button>
            ))}
          </span>
          <span
            title="拖动调整大小"
            className="absolute right-0 bottom-0 hidden size-4 cursor-nwse-resize rounded-tl-md border-t-2 border-l-2 border-accent bg-surface/80 group-hover/img:block"
            onPointerDown={(e) => {
              e.preventDefault();
              const el = e.currentTarget;
              const im = box.current?.querySelector("img");
              if (!im) return;
              const x0 = e.clientX,
                w0 = im.getBoundingClientRect().width,
                max = box.current!.parentElement!.getBoundingClientRect().width;
              let cur = w0;
              el.setPointerCapture(e.pointerId);
              const move = (ev: PointerEvent) => {
                cur = Math.max(80, Math.min(max, w0 + ev.clientX - x0));
                setDrag(cur);
              };
              const up = () => {
                el.removeEventListener("pointermove", move);
                el.removeEventListener("pointerup", up);
                if (Math.abs(cur - w0) > 3) edit(idx, cur);
                setDrag(null);
              };
              el.addEventListener("pointermove", move);
              el.addEventListener("pointerup", up);
            }}
          />
        </span>
      ) : (
        img
      )}
      {big && <Lightbox src={url} onClose={() => setBig(false)} />}
    </>
  );
}

/** 附件在桌面版用系统程序打开（主机模式直接打开数据文件夹里的文件） */
export function useOpenAsset() {
  const cfg = useConfig().data?.config;
  return (name: string) => {
    if (!isApp || !cfg) return window.open("/api/asset/" + encodeURIComponent(name), "_blank");
    const p =
      cfg.mode === "host"
        ? cfg.dataDir.replace(/[\\/]+$/, "") + (cfg.dataDir.includes("/") ? "/assets/" : "\\assets\\") + name
        : cfg.serverUrl.replace(/\/+$/, "") + "/api/asset/" + name;
    openTarget(p);
  };
}

function Link({ href, children }: { href?: string; children?: ReactNode }) {
  const openAsset = useOpenAsset();
  const h = String(href || "");
  if (h.startsWith("asset:")) {
    return (
      <a
        href="#"
        onClick={(e) => {
          e.preventDefault();
          openAsset(h.slice(6));
        }}
      >
        {children}
      </a>
    );
  }
  return (
    <a
      href={h}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => {
        if (isApp && /^https?:/i.test(h)) {
          e.preventDefault();
          openTarget(h);
        }
      }}
    >
      {children}
    </a>
  );
}

function Mark(props: { children?: ReactNode; className?: string; "data-qa"?: string }) {
  const onClick = useContext(MarkClick);
  const id = props["data-qa"];
  return (
    <mark className={props.className} data-qa={id} onClick={id && onClick ? () => onClick(id) : undefined} title={id ? "查看问答" : undefined}>
      {props.children}
    </mark>
  );
}

const transform = (url: string) => (url.startsWith("asset:") ? url : defaultUrlTransform(url));
/* ---- 一键复制：代码块右上角按钮；行内代码、路径点一下就复制 ---- */
const copied = async (v: string) => useUi.getState().say((await copyText(v)) ? "已复制：" + (v.length > 40 ? v.slice(0, 40) + "…" : v) : "复制失败");
function Pre(props: { children?: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  return (
    <div className="group/pre relative">
      <pre ref={ref}>{props.children}</pre>
      <button
        data-qa-skip
        onClick={() => copied(ref.current?.innerText.replace(/\n$/, "") || "")}
        className="absolute top-2 right-2 rounded-md bg-surface px-2 py-0.5 text-xs text-muted opacity-0 shadow-1 group-hover/pre:opacity-100 hover:text-fg"
      >
        复制
      </button>
    </div>
  );
}
function Code(props: { children?: ReactNode; className?: string; node?: { position?: unknown } }) {
  // 代码块里的 <code> 带 language- 类名或多行，交给 Pre；行内代码点一下复制
  const text = String(props.children ?? "");
  if (/language-/.test(props.className || "") || text.includes("\n")) return <code className={props.className}>{props.children}</code>;
  return (
    <code className="xp-copy" title="点击复制" onClick={() => copied(text)}>
      {props.children}
    </code>
  );
}
function Span(props: { children?: ReactNode; className?: string; "data-copy"?: string }) {
  const v = props["data-copy"];
  if (!v) return <span className={props.className}>{props.children}</span>;
  return (
    <span className="xp-path" title="点击复制路径" onClick={() => copied(v)}>
      {props.children}
    </span>
  );
}

const components = { img: AssetImg, a: Link, mark: Mark, pre: Pre, code: Code, span: Span } as unknown as Components;

const Render = memo(function Render({ src, qa, lost }: { src: string; qa?: Qa[]; lost?: Set<string> }) {
  const rehype = useMemo(() => (qa && qa.length && lost ? [rehypeImgIndex, [rehypeQaMarks, { qa, lost }], rehypePaths] : [rehypeImgIndex, rehypePaths]), [qa, lost]);
  return (
    // 单个换行也换行（和旧界面一致）
    <Markdown remarkPlugins={[remarkGfm, remarkBreaks]} rehypePlugins={rehype as never} urlTransform={transform} components={components}>
      {src}
    </Markdown>
  );
});

export function Md({
  src,
  className,
  qa,
  lost,
  onImageWidth,
  onMark,
}: {
  src: string;
  className?: string;
  qa?: Qa[];
  lost?: Set<string>;
  onImageWidth?: (idx: number, w: number) => void;
  onMark?: (id: string) => void;
}) {
  return (
    <ImgEdit.Provider value={onImageWidth ?? null}>
      <MarkClick.Provider value={onMark ?? null}>
        <div className={"prose-x " + (className || "")}>
          <Render src={src} qa={qa} lost={lost} />
        </div>
      </MarkClick.Provider>
    </ImgEdit.Provider>
  );
}

/** 卡片上的缩略图 */
export function Thumb({ name, className }: { name: string; className?: string }) {
  const url = useAssetUrl(name);
  return url ? <img src={url} alt="" className={className} /> : <span className={"block bg-surface-2 " + (className || "")} />;
}
