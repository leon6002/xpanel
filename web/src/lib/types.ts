/** 条目：自由 JSON，常用字段在这里列出，其他字段原样保留 */
export type ItemType = "todo" | "issue" | "idea" | "note" | "link" | "rule" | "inbox" | "project";
export type Priority = "P0" | "P1" | "P2" | "P3";

/** AI 回答一次用了多少 token（桌面版从 claude / codex 的输出里读；拿不到就没有） */
export interface Usage { input: number; output: number; cached?: number; cost_usd?: number }
export interface QaTurn { q: string; a: string; at: number; by?: string; usage?: Usage; /** 回答存成了哪篇笔记 */ saved?: string }
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
  /** 属于哪个项目（项目条目的 id；"none" = 不属于任何项目；没写就按关键词认，见 lib/projects.ts） */
  project?: string;
  /** 交给 AI 之前的讨论：它问的问题、你的回答、计划（见 lib/brief.ts） */
  brief?: unknown;
  /** 父笔记（笔记、规范可以分层） */
  parentId?: string;
  /** 关联的其他条目（见 lib/links.ts） */
  links?: { id: string; label?: string }[];
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
export const typeName = (t: ItemType) => (t === "inbox" ? "收件箱" : t === "project" ? "项目" : TYPES.find((x) => x.k === t)?.name ?? t);
export const isCheckable = (t: ItemType) => !!TYPES.find((x) => x.k === t)?.check;

/* ---- 外置硬盘同步（/api/v1/backup） ---- */
/** 外置硬盘上的一份一键备份（latest.json） */
export interface DriveBackup { at: number; file: string; rev: number; items: number; assets: number; assetBytes: number; replicaId: string; replicaName: string }
export interface DriveStatus {
  /** 外置硬盘上的文件夹（在主机上设置） */
  dir: string | null;
  /** 文件夹在不在（硬盘插没插） */
  available: boolean;
  running: boolean;
  /** 外置硬盘上最近一次备份 */
  last: DriveBackup | null;
  /** 本机的数据文件夹是谁 */
  replica: { id: string; name: string };
  /** 本机上次对齐的那份备份 */
  base: DriveBackup | null;
  /** 外置硬盘上有别的电脑的新备份，要先合并 */
  needsMerge: boolean;
}
export type MergeChoice = "remote" | "local" | "both";
export interface MergeChange {
  id: string;
  kind: "add" | "update" | "delete" | "conflict";
  type: ItemType;
  title: string;
  localTitle?: string | null;
  remoteDeleted: boolean;
  localDeleted: boolean;
  remoteAt: number;
  localAt?: number | null;
  /** 在哪台电脑改的 */
  originName: string;
  originIsMe: boolean;
  /** 默认选哪边 */
  choice: "remote" | "local";
}
export interface MergePreview { latest: DriveBackup; base: DriveBackup | null; first: boolean; changes: MergeChange[]; counts: Record<string, number>; assets: { missing: number; bytes: number } }
export interface BackupResult { needsMerge?: boolean; latest?: DriveBackup; manifest?: DriveBackup; copiedFiles?: number; copiedBytes?: number }
export interface MergeResult { applied: Record<string, number>; kept: number; copiedFiles: number; copiedBytes: number; other?: { vault?: { keys: number; secrets: number; keptOld: number } } }

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
  /** 外置硬盘上的文件夹（一键备份和合并用） */
  syncDir?: string;
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
