/* 导出上下文：把一件事的全部材料打成一个压缩包——这一条本身、和 AI 的讨论、评论、关联的条目，以及它们里面的图片和附件。
   解开就是一个文件夹，先读 README.md；交给任何 AI（或者人）都能接着做。
   在界面里打包（附件通过 assetSrc 取），所以桌面版的主机模式、连接模式和浏览器都能用。 */
import { strToU8, zipSync } from "fflate";
import { assetSrc, invoke } from "./api";
import { briefDigest, briefOf } from "./brief";
import { relatedOf } from "./links";
import { entryTarget, noteTitle } from "./logic";
import type { Item } from "./types";
import { typeName } from "./types";

const FILES = "files";
const safe = (s: string) =>
  (s || "")
    .replace(/[\\/:*?"<>|\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40) || "untitled";
const stamp = (t?: number) => (t ? new Date(t).toLocaleString("zh-CN") : "");

/** 正文里引用的附件：asset:名字 → 压缩包里的相对路径；顺便记下每个附件在正文里叫什么 */
function relink(body: string, prefix: string, seen: Map<string, string>) {
  return String(body || "")
    .replace(/(!?)\[([^\]]*)\]\(asset:([^)\s]+)\)/g, (_m, bang: string, label: string, name: string) => {
      const clean = label.replace(/\|\d+$/, "").replace(/^📎\s*/, "");
      if (!seen.has(name) || (!seen.get(name) && clean)) seen.set(name, clean);
      return `${bang}[${clean}](${prefix}${FILES}/${name})`;
    })
    .replace(/\[([^\]]*)\]\(xpanel:item\/[^)]+\)/g, "《$1》");
}

function itemMd(it: Item, prefix: string, seen: Map<string, string>, label?: string) {
  const L = [`# ${it.type === "note" || it.type === "rule" ? noteTitle(it) : it.title || "(无标题)"}`, ``];
  const meta = [
    `类型：${typeName(it.type)}`,
    label && `和这件事的关系：${label}`,
    it.category && `分类：${it.category}`,
    (it.tags || []).length && `标签：${(it.tags || []).map((t) => "#" + t).join(" ")}`,
    it.priority && `优先级：${it.priority}`,
    it.due && `截止：${it.due}`,
    it.type === "link" && entryTarget(it) && `地址：${entryTarget(it)}`,
    it.done && `状态：已完成`,
    `最后修改：${stamp(it.updatedAt)}`,
  ].filter(Boolean);
  L.push(...meta.map((m) => "- " + m), ``, relink(it.body || "", prefix, seen).trim() || "（没有正文）");
  return L.join("\n") + "\n";
}

function commentsMd(it: Item) {
  const list = it.qa || [];
  if (!list.length) return "";
  const L = [`# 评论`, ``];
  list.forEach((q, i) => {
    L.push(`## ${i + 1}. ${q.quote ? "针对这段原文" : "针对整条"}`, ``);
    if (q.quote) L.push(...q.quote.split("\n").map((l) => "> " + l), ``);
    for (const t of q.turns || []) {
      if (t.q) L.push(`**我：** ${t.q}`, ``);
      if (t.a) L.push(`**${t.by || "AI"}：**`, ``, t.a, ``);
    }
  });
  return L.join("\n") + "\n";
}

async function bytesOf(name: string): Promise<Uint8Array | null> {
  try {
    const r = await fetch(await assetSrc(name));
    if (!r.ok) return null;
    return new Uint8Array(await r.arrayBuffer());
  } catch {
    return null;
  }
}

/** 打包。返回压缩包的内容、建议的文件名，和里面有什么（给界面提示用） */
export async function buildContextZip(it: Item, all: Item[]) {
  const related = relatedOf(all, it).slice(0, 40);
  const seen = new Map<string, string>();
  const out: Record<string, Uint8Array> = {};
  const index: string[] = [];
  out["task.md"] = strToU8(itemMd(it, "", seen));
  index.push("- `task.md`：这件事本身（标题、正文、截止和优先级）");
  const b = briefOf(it);
  if (b) {
    out["discussion.md"] = strToU8(briefDigest(b) + "\n");
    index.push(`- \`discussion.md\`：和 AI 讨论的问答${b.plan ? "，以及定下来的计划" : ""}。**做之前先看这个，里面是我确认过的要求**`);
  }
  const c = commentsMd(it);
  if (c) {
    out["comments.md"] = strToU8(c);
    index.push("- `comments.md`：这一条下面的评论和 AI 的回答");
  }
  related.forEach((r, i) => {
    const name = `related/${String(i + 1).padStart(2, "0")}-${safe(r.item.type === "note" ? noteTitle(r.item) : r.item.title)}.md`;
    out[name] = strToU8(itemMd(r.item, "../", seen, r.label));
    index.push(`- \`${name}\`：${r.label ? "【" + r.label + "】" : "关联的"}${typeName(r.item.type)}`);
  });
  const missing: string[] = [];
  let nFiles = 0;
  for (const [name, label] of seen) {
    const data = await bytesOf(name);
    if (!data) {
      missing.push(label || name);
      continue;
    }
    out[`${FILES}/${name}`] = data;
    nFiles++;
    index.push(`- \`${FILES}/${name}\`：${/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name) ? "图片" : "附件"}${label ? "「" + label + "」" : ""}`);
  }
  const title = it.type === "note" ? noteTitle(it) : it.title || "untitled";
  out["README.md"] = strToU8(
    [
      `# ${title}`,
      ``,
      `这是从 xpanel（个人工作台）导出的一件事的全部材料，${stamp(Date.now())} 导出。`,
      ``,
      `## 怎么用`,
      ``,
      `把整个文件夹交给 AI（或者人）。先读这个文件，再按下面的顺序读；Markdown 里的图片和附件用的是相对路径，都在 \`${FILES}/\` 里。`,
      ``,
      `## 里面有什么`,
      ``,
      ...index,
      ...(missing.length ? [``, `有 ${missing.length} 个附件没取到，没放进来：${missing.join("、")}`] : []),
      ``,
    ].join("\n"),
  );
  // README 排在最前面
  const ordered = Object.fromEntries([["README.md", out["README.md"]], ...Object.entries(out).filter(([k]) => k !== "README.md")]);
  const zip = zipSync(ordered, { level: 6 });
  const day = new Date().toLocaleDateString("sv");
  return { zip, name: `${safe(title)}-上下文-${day}.zip`, related: related.length, files: nFiles, missing };
}

const b64 = (u: Uint8Array) => {
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};

/** 存到电脑上：桌面版存进「下载」文件夹（返回存到了哪），浏览器走下载 */
export async function saveFile(name: string, data: Uint8Array): Promise<string | null> {
  if (invoke) return invoke<string>("save_download", { name, data: b64(data) });
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type: "application/zip" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return null;
}
