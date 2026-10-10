/* 项目：一条内容是为哪件事做的（工作上的一个项目、自己在做的一个东西…）。和分类是两个维度：分类说「这是什么东西」，项目说「这是为哪件事」。
   - 项目本身是一条 type = "project" 的条目：title 是名称，body 是说明（给自己和 AI 看的背景），
     keywords 是用来认的关键词，status 是状态，dirs 是它在各台电脑上的文件夹。所以它和别的条目一样同步、合并。
   - 别的条目用 project 字段写项目的 id；没写的按关键词自己认（标题、标签、分类里出现了项目的名称或关键词，再不行看正文）；
     写 "none" = 明说不属于任何项目。认是算出来的、不落库：改了关键词，归属马上跟着变。
   - 一条只属于一个项目；真要跨项目用关联。密码库的条目同理（project 在密文里）。 */
import type { Item } from "./types";

export type ProjectStatus = "active" | "paused" | "done";
export const STATUS_NAME: Record<ProjectStatus, string> = { active: "进行中", paused: "搁置", done: "结束" };
export interface ProjectDir { deviceId?: string; hostname?: string; path: string }
export interface Project { id: string; name: string; keywords: string[]; status: ProjectStatus; about: string; dirs: ProjectDir[]; item: Item }

export const NO_PROJECT = "none";

export function projectsOf(items: Item[]): Project[] {
  const order: Record<ProjectStatus, number> = { active: 0, paused: 1, done: 2 };
  return items
    .filter((i) => i.type === "project")
    .map((i) => ({
      id: i.id,
      name: i.title || "未命名项目",
      keywords: (Array.isArray(i.keywords) ? (i.keywords as unknown[]) : []).map((k) => String(k).trim()).filter(Boolean),
      status: (["active", "paused", "done"].includes(String(i.status)) ? i.status : "active") as ProjectStatus,
      about: String(i.body || ""),
      dirs: (Array.isArray(i.dirs) ? (i.dirs as ProjectDir[]) : []).filter((d) => d && d.path),
      item: i,
    }))
    .sort((a, b) => order[a.status] - order[b.status] || a.item.createdAt - b.item.createdAt);
}

/** 关键词在不在这段话里。数字的关键词两边不能还是数字，字母的两边不能还是字母（8266 能认出 esp8266，但 ai 不会认到 email 里）；中文包含就算 */
function has(text: string, kw: string) {
  const k = kw.toLowerCase();
  if (!k) return false;
  for (let at = text.indexOf(k); at >= 0; at = text.indexOf(k, at + 1)) {
    const cls = (c?: string) => (!c ? "" : /[0-9]/.test(c) ? "d" : /[a-z]/.test(c) ? "a" : "");
    const head = cls(k[0]);
    const tail = cls(k[k.length - 1]);
    if ((!head || cls(text[at - 1]) !== head) && (!tail || cls(text[at + k.length]) !== tail)) return true;
  }
  return false;
}

/** 从几段文字里认项目：前面的文字优先（标题比正文可信），同一段里取对上的最长的关键词 */
export function detectProject(texts: (string | undefined)[], projects: Project[]): Project | undefined {
  for (const raw of texts) {
    const t = (raw || "").toLowerCase();
    if (!t) continue;
    let best: Project | undefined;
    let len = 0;
    for (const p of projects) {
      if (p.status === "done") continue;
      for (const k of [p.name, ...p.keywords]) {
        if (k.length > len && has(t, k)) {
          best = p;
          len = k.length;
        }
      }
    }
    if (best) return best;
  }
  return undefined;
}

type Tagged = { type?: string; project?: unknown; title?: string; body?: string; tags?: string[]; category?: string };
/** 这一条属于哪个项目：写了的以写的为准，没写的自己认 */
export function projectOf(it: Tagged | null | undefined, projects: Project[]): Project | undefined {
  if (!it || it.type === "project" || !projects.length) return undefined;
  if (it.project === NO_PROJECT) return undefined;
  if (typeof it.project === "string" && it.project) return projects.find((p) => p.id === it.project);
  return detectProject([[it.title, (it.tags || []).join(" "), it.category].filter(Boolean).join("\n"), (it.body || "").slice(0, 2000)], projects);
}
/** 密码库里的一条属于哪个项目（名称、用途、标签里认，再不行看网址和备注） */
export const secretProject = (f: { kind?: string; project?: string; title: string; label?: string; tags?: string[]; url?: string; notes?: string } | null | undefined, projects: Project[]) =>
  !f || f.kind === "raw" ? undefined : projectOf({ project: f.project, title: f.title, category: f.label, tags: f.tags, body: [f.url, f.notes].filter(Boolean).join("\n") }, projects);
/** 是不是用户明确指定的（不是自己认的） */
export const projectPinned = (it: Tagged) => typeof it.project === "string" && !!it.project;

/** 交给 AI 时把所属的项目当成一条关联的材料带上（项目的说明、文件夹） */
export function projectAsRelated(it: Item, items: Item[]): { item: Item; label: string }[] {
  const p = projectOf(it, projectsOf(items));
  return p ? [{ item: p.item, label: "所属项目" }] : [];
}

/** 这个项目在这台电脑上的文件夹 */
export function dirOf(p: Project | undefined, me: { id: string; hostname: string }) {
  if (!p) return "";
  const hn = me.hostname.toLowerCase();
  return (p.dirs.find((d) => me.id && d.deviceId === me.id) ?? p.dirs.find((d) => !d.deviceId && hn && String(d.hostname || "").toLowerCase() === hn))?.path ?? "";
}
/** 记下这个项目在这台电脑上的文件夹（空 = 去掉） */
export function withDir(p: Project, me: { id: string; hostname: string }, path: string): ProjectDir[] {
  const hn = me.hostname.toLowerCase();
  const others = p.dirs.filter((d) => !((me.id && d.deviceId === me.id) || (hn && String(d.hostname || "").toLowerCase() === hn)));
  return path.trim() ? [...others, { deviceId: me.id || undefined, hostname: me.hostname || undefined, path: path.trim() }] : others;
}
