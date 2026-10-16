/* 图片复制和保存：把正文、消息、大图里的图片本身放进剪贴板（不是 ![…](asset:…) 这段文字），或者存到电脑上。
   src 就是页面上 <img> 的地址：桌面版是 data: 网址，浏览器是 /api/asset/名字。 */
import { assetSrc, copyText, invoke } from "./api";
import { imageRefs } from "./logic";

/** 图片的原始数据 */
async function blobOf(src: string): Promise<Blob> {
  const m = src.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (m) {
    const raw = m[2] ? atob(m[3]) : decodeURIComponent(m[3]);
    const u = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) u[i] = raw.charCodeAt(i);
    return new Blob([u], { type: m[1] || "application/octet-stream" });
  }
  const r = await fetch(src);
  if (!r.ok) throw new Error("读不到图片 " + r.status);
  return r.blob();
}

/** 剪贴板只认 PNG：别的格式（jpg、webp、gif）先画一遍转成 PNG */
async function pngOf(b: Blob): Promise<Blob> {
  if (b.type === "image/png") return b;
  const bmp = await createImageBitmap(b);
  const c = document.createElement("canvas");
  c.width = bmp.width;
  c.height = bmp.height;
  c.getContext("2d")!.drawImage(bmp, 0, 0);
  bmp.close();
  return new Promise((res, rej) => c.toBlob((x) => (x ? res(x) : rej(new Error("转换图片失败"))), "image/png"));
}

/** 能不能直接往剪贴板放图片：桌面版能；浏览器要 https 或 localhost（局域网里用 http 打开的不行） */
export const canCopyImage = () => typeof navigator.clipboard?.write === "function" && typeof window.ClipboardItem === "function" && window.isSecureContext;

/** 把图片放进剪贴板，之后在微信、飞书、画图里直接粘贴。
 *  不能直接复制时（局域网的 http 网页）在新标签页打开它，在那里右键「复制图片」，返回 "opened" */
export async function copyImage(src: string): Promise<"copied" | "opened"> {
  if (!canCopyImage()) {
    window.open(src, "_blank", "noopener");
    return "opened";
  }
  // 传 Promise 进去：转换要一会儿，先把这次点击占住，免得浏览器以为不是用户点的
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blobOf(src).then(pngOf) })]);
  return "copied";
}

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/bmp": "bmp", "image/svg+xml": "svg" };

/** 存成文件：桌面版存进「下载」文件夹（返回存到了哪），浏览器走下载 */
export async function saveImage(src: string, name?: string): Promise<string | null> {
  const b = await blobOf(src);
  const ext = EXT[b.type] || "png";
  const base = (name || "").replace(/\|\d+$/, "").trim() || "图片";
  const file = /\.[a-z0-9]{2,5}$/i.test(base) ? base : `${base}.${ext}`;
  if (invoke) {
    const u = new Uint8Array(await b.arrayBuffer());
    let s = "";
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
    return invoke<string>("save_download", { name: file, data: btoa(s) });
  }
  const url = URL.createObjectURL(b);
  const a = document.createElement("a");
  a.href = url;
  a.download = file;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return null;
}

/** 「复制」一条消息或条目：只有图片没有文字的（比如随手发的截图）复制图片本身，别的照旧复制文字。
 *  返回给用户看的提示 */
export async function copyItem(title: string, body: string | undefined): Promise<string> {
  const imgs = imageRefs(body);
  const text = [title, String(body || "").replace(/!\[[^\]]*\]\(asset:[^)]*\)/g, "")]
    .map((s) => s.trim())
    .filter(Boolean)
    .join("\n");
  if (!text && imgs.length) {
    const r = await copyImage(await assetSrc(imgs[0]));
    if (r === "opened") return "网页版在 http 下不能直接复制图片：已在新标签页打开，在图片上右键「复制图片」";
    return imgs.length > 1 ? `已复制第 1 张图片（共 ${imgs.length} 张，其余的点开大图再复制）` : "已复制图片";
  }
  return (await copyText([title, body].filter(Boolean).join("\n"))) ? "已复制" : "复制失败";
}

export const copiedMsg = (r: "copied" | "opened") => (r === "copied" ? "已复制图片" : "网页版在 http 下不能直接复制图片：已在新标签页打开，在图片上右键「复制图片」");
