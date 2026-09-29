import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { assetSrc, isApp, openTarget } from "../lib/api";

/** 正文里的附件写成 asset:名字；图片说明末尾的 |480 是显示宽度（和 Obsidian 一样） */
function AssetImg({ src, alt }: { src?: string; alt?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [big, setBig] = useState(false);
  const m = String(alt || "").match(/^(.*?)\|(\d{2,4})$/);
  const label = m ? m[1] : alt || "";
  const width = m ? +m[2] : undefined;
  useEffect(() => {
    let alive = true;
    const s = String(src || "");
    if (s.startsWith("asset:")) assetSrc(s.slice(6)).then((u) => alive && setUrl(u)).catch(() => alive && setUrl(null));
    else setUrl(s);
    return () => {
      alive = false;
    };
  }, [src]);
  if (!url) return <span className="inline-block rounded-lg bg-surface-2 px-2 text-xs text-faint">{label || "图片"}</span>;
  return (
    <>
      <img src={url} alt={label} style={width ? { width } : undefined} onClick={() => setBig(true)} />
      {big &&
        createPortal(
          <div className="fixed inset-0 z-50 grid cursor-zoom-out place-items-center bg-black/80 p-6" onClick={() => setBig(false)}>
            <img src={url} alt={label} className="max-h-[92vh] max-w-[94vw] rounded-lg shadow-3" />
          </div>,
          document.body,
        )}
    </>
  );
}

function Link({ href, children }: { href?: string; children?: React.ReactNode }) {
  const h = String(href || "");
  if (h.startsWith("asset:")) {
    const name = h.slice(6);
    return (
      <a
        href={isApp ? "#" : "/api/asset/" + encodeURIComponent(name)}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => {
          if (isApp) {
            e.preventDefault();
            openTarget("/api/asset/" + name);
          }
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

const transform = (url: string) => (url.startsWith("asset:") ? url : defaultUrlTransform(url));

export function Md({ src, className }: { src: string; className?: string }) {
  return (
    <div className={"prose-x " + (className || "")}>
      <Markdown remarkPlugins={[remarkGfm]} urlTransform={transform} components={{ img: AssetImg, a: Link }}>
        {src}
      </Markdown>
    </div>
  );
}

/** 卡片上的缩略图 */
export function Thumb({ name, className }: { name: string; className?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    assetSrc(name).then((u) => alive && setUrl(u)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [name]);
  return url ? <img src={url} alt="" className={className} /> : <span className={"block bg-surface-2 " + (className || "")} />;
}
