/** 条目：自由 JSON，常用字段在这里列出，其他字段原样保留 */
export type ItemType = "todo" | "issue" | "idea" | "note" | "link" | "rule" | "inbox";
export type Priority = "P0" | "P1" | "P2" | "P3";

export interface QaTurn { q: string; a: string; at: number; by?: string }
export interface Qa { id: string; quote: string; prefix?: string; suffix?: string; at: number; turns: QaTurn[] }
export interface Progress { at: number; by?: string; status: "working" | "done" | "blocked"; text: string; files?: string[] }
export interface Workspace { deviceId?: string; hostname?: string; path: string; name: string; template?: string; createdAt?: number }

export interface Item {
  id: string;
  type: ItemType;
  title: string;
  body?: string;
  tags?: string[];
  category?: string;
  device?: string;
  done?: boolean;
  pinned?: boolean;
  priority?: Priority;
  due?: string;
  rank?: number;
  createdAt: number;
  updatedAt: number;
  doneAt?: number;
  createdBy?: string;
  qa?: Qa[];
  agentProgress?: Progress[];
  agentLog?: { agent: string; at: number }[];
  workspaces?: Workspace[];
  [k: string]: unknown;
}

export interface Device {
  id: string;
  name: string;
  kind?: string;
  description?: string;
  aliases?: string[];
  os?: string;
  agentVersion?: string;
  isHost?: boolean;
  aiTools?: string[];
  lastSeen?: number;
  hostname?: string;
  networks?: { name?: string; ip?: string; note?: string }[];
  reportedIps?: { ip: string; iface?: string }[];
  projects?: { name: string; path: string; agent?: string; note?: string }[];
  [k: string]: unknown;
}

export interface State {
  rev: string | number;
  items: Item[];
  devices?: Device[];
  categories?: string[];
  offline?: boolean;
  pending?: number;
  error?: string;
}

export const TYPES: { k: ItemType; name: string; short?: string; check?: string; lane?: boolean }[] = [
  { k: "todo", name: "待办", check: "完成", lane: true },
  { k: "issue", name: "问题", check: "已解决", lane: true },
  { k: "idea", name: "灵感", check: "已落地", lane: true },
  { k: "note", name: "笔记" },
  { k: "link", name: "入口" },
  { k: "rule", name: "规范与工作流", short: "规范" },
];
export const typeName = (t: ItemType) => (t === "inbox" ? "收件箱" : TYPES.find((x) => x.k === t)?.name ?? t);
export const isCheckable = (t: ItemType) => !!TYPES.find((x) => x.k === t)?.check;

/* ---- 桌面版配置（get_config） ---- */
export interface Agent { name: string; cmd: string; ask?: string }
export interface Config {
  mode: "" | "host" | "client";
  dataDir: string;
  serverUrl: string;
  port: number;
  lanEnabled: boolean;
  agents: Agent[];
  agentCwd: string;
  coldBackupDir?: string | null;
  deviceId: string;
}
export interface Lan { running: boolean; hostname?: string; urls: string[]; port?: number }
export interface AppConfig { config: Config; lan: Lan | null; hostname: string }

/* ---- 收件箱：导入的微信聊天 ---- */
export interface Chat { id: string; name: string; count: number; unread: number; readUpTo?: string; last?: { sender?: string; text?: string; time?: string } }
export interface Attachment { name: string; kind: "image" | "video" | "file" | string; asset?: string; missing?: boolean }
export interface Msg { id: string; chat?: string; sender: string; time: string; text: string; attachments?: Attachment[] }
export interface Bundle { id?: string; importedAt: number; fileName?: string; start?: string; end?: string; total: number; added: number; files?: string[] }
export interface WxPreview {
  count: number;
  start: string;
  end: string;
  files: number;
  missing: number;
  suggestedChat?: string;
  matchedChat?: { id: string; name: string; duplicates?: number } | null;
  senders?: { name: string; count: number }[];
}

/* ---- 交给 AI 的任务模板 ---- */
export interface Template { id: string; name: string; goal: string; prompt: string; resume: string }
