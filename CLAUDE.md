# 开发说明（给 AI 编程助手和贡献者）

## 结构
- `crates/xp-core`：条目模型、v1 操作（Op）、优先级、筛选排序、导出、统计。纯逻辑，不碰文件和网络。
- `crates/xp-store`：SQLite 存储（`xpanel.db`）。条目整条 JSON 存在 `data` 列，常用字段另拆列；软删除；每次写入 `rev` +1 并通过 broadcast 通知；
  每日备份 + 冷备份；首次打开自动导入 v1 的 `workbench.json`；API key（只存哈希）；操作记录 `audit_log`。
- `crates/xp-server`：axum。v1 兼容接口（`/`、`/api/state|rev|op|asset|ping`，旧界面和连接模式在用）+ `/api/v1/*` 对外接口 + SSE。
  接口文档手写在 `openapi.rs`，改接口时同步改，测试会检查路由都在。
- 设备：`xp-core/src/device.rs`（字段规则、心跳合并）+ `xp-store/src/devices.rs`（表、改名同步条目、从旧条目生成）。
  桌面版 `src-tauri/src/device.rs` 每分钟发心跳；界面通过 `api_call` 命令调 `/api/v1`（主机模式在本进程处理，连接模式转发）。
- 分类和标签：`xp-core/src/category.rs`（路径规则）+ `xp-store/src/categories.rs`（空分类表、改名/移动/删除同步到条目）。
- 收件箱：随手发的是 `type=inbox` 的普通条目（界面 `web/src/components/Inbox.tsx`）。
  微信聊天记录：`xp-core/src/wechat.rs`（TXT 格式解析、附件引用、Markdown）+ `xp-store/src/inbox.rs`（chats / bundles / messages 表，
  附件按内容哈希存成 `assets/wx-*.ext`，消息按指纹去重）+ `xp-server/src/inbox.rs`（`/api/v1/inbox/*`，导入接口单独放宽了请求体上限）。
  测试只用自己编的聊天记录，**不要把真实的导出文件或内容放进仓库**。
- MCP：`crates/xp-cli/src/mcp.rs`（`xp mcp`，标准输入输出的 JSON-RPC，每个工具调一次 `/api/v1`）。加接口时考虑要不要加对应的工具，工具说明用中文写清楚参数格式。
- 笔记展开成项目：`crates/xp-workspace`（目录结构、截图固定编号、同步、更新记录、「继续」提示词；桌面版 `src-tauri/src/workspace.rs` 和 `xp workspace` / MCP 共用）。
  条目上的 `workspaces`（哪台设备、哪个目录）、`agentProgress`（AI 回写的进展）；模板在 `xp-core/src/templates.rs`（内置）+ 数据库 meta（用户改过的）。
- 评论（原来的「划词问 AI」）：笔记下面的评论区 + 选中正文后的批注，评论里 `@AI名字` 就由桌面版 `ask_ai` 在后台回答
  （`src-tauri/src/agent.rs` 的 `ask`，提示词走标准输入，claude → `claude -p`、codex → `codex exec -`）。界面在 `web/src/components/Comments.tsx`。
  存在条目的 `qa`（`{id, quote, prefix, suffix, at, resolved?, turns:[{q,a,at,by}]}`：q 是人写的、a 是 AI 的回答、by 是哪个 AI），
  按原话 + 前后文定位；全文索引包含评论内容；MCP 的 `xpanel_add_qa` 写的也是这个字段。
- 关联：条目的 `links: [{id, label?}]`（发起方存，另一边显示「关联了这条」）；正文里 `[标题](xpanel:item/ID)` 是引用（编辑器里输入 `[[`）。
  界面 `web/src/lib/links.ts` + `web/src/components/Related.tsx`。评论里 @AI 时关联条目的内容和附件一起给 AI；AI 的回答可以「存为笔记」并以「产出」关联回来。
- 多台电脑同时改：界面改字段用 `patch` 操作（`xp-core` 的 `Op::Patch`，只发改动的字段，在主机的最新内容上合并）；
  编辑器保存标题、正文时带 `expect`（这边最后同步到的内容），主机上对不上就返回冲突（409），界面提示「用对方的 / 用我的 / 两份都留」，不会静默覆盖。
- 子笔记：条目的 `parentId` 指向父笔记（笔记、规范）。找不到父笔记就当顶层；删除父笔记时子笔记挪到上一层（`xp-store` 的 `soft_delete`）。
  界面 `web/src/lib/tree.ts` + `web/src/components/Tree.tsx`（路径、子笔记列表、移动到…、列表里拖动改层级）。
- `crates/xp-cli`：`xp` 命令行，走 `/api/v1`；`xp key` 和 `xp serve` 直接读写数据文件夹。
- `src-tauri`：桌面版。主机模式用 xp-store + xp-server；连接模式（`client.rs`）读写主机的 v1 接口，离线队列 `pending.json`。
- `web/`：界面（Vite + React 19 + TypeScript + Tailwind v4 + Radix），构建到 `web/dist`。桌面版直接用它（`tauri.conf.json` 的 frontendDist，`beforeBuildCommand` 先构建），
  xp-server 把它编进程序挂在 `/`（`crates/xp-server/src/web.rs`，rust-embed；调试构建直接读磁盘上的 dist）。
  - `src/components/`：Sidebar、ListPane、Reader（含右侧浮出面板 Peek）、Inbox、Capture、Global（横幅、选中文字后的评论浮窗、全局粘贴/拖放、快捷键）、
    BlockEditor（所见即所得的块编辑器，TipTap；扩展和 Markdown 读写在 `lib/editor.ts`，正文仍存 Markdown）、Comments、Tree
  - `src/dialogs/`：交给 AI（含任务模板）、设置、设备、分类和标签、微信导入 / 聊天设置 / 追加到笔记
  - `src/lib/qa.ts`：评论定位（rehype 插件给原文加 `<mark>`）；`lib/ws.ts`：项目目录同步；`lib/drafts.ts`：输入框草稿和待发送附件
  - `src/lib/api.ts` 是唯一的传输层：桌面版走 Tauri 命令（读写条目仍用 `get_state`/`apply_op`，保留连接模式的离线队列），浏览器走 HTTP。
  - `src/lib/data.ts`：TanStack Query 缓存全部条目，写入先改本地再提交；`src/lib/store.ts`：zustand 界面状态。
  - 颜色只用 `src/index.css` 里的设计变量（`bg-surface`、`text-muted`、`bg-accent-soft`…），浅色/深色各一套，不在组件里写色值。
- `ui/index.html`：旧界面（单文件原生 JS），挂在 `/old/`，只修严重问题，新功能只做在 `web/`。

## 约定
- 界面同时跑在两种环境：桌面版（`window.__TAURI__` 存在，走 `invoke`）和浏览器（走 `/api/*`）。新功能两边都要考虑。
- 改旧界面（`ui/index.html`）时把 `<meta name="wb-ui-version">` 加 1。
- 条目是自由 JSON（`id/type/title/body/tags/category/device/done/pinned/createdAt/updatedAt/priority/due/rank/doneAt/createdBy/agentLog`），按 `id` 合并。
- 错误分三类（`StoreError`）：`Invalid` → 400（客户端不重试）、`NotFound` → 404、`Unavailable` → 503（客户端留着稍后重试）。别把请求本身的问题报成 503。
- 数据库结构变更：在 `xp-store/src/schema.rs` 的 `MIGRATIONS` 末尾追加，不改已有的。
- 用户界面文字、错误信息用中文，简短直白。
- 不要把个人数据、机器名、IP 提交进仓库（数据文件、`backups/`、`assets/`、`CLAUDE.local.md` 已被忽略）。

## 提交规则（强制）
- 格式：标题一行 `类型(范围): 摘要`，空一行，再写改动说明（必须有）。例：
  ```
  feat(web): add quick capture to the new UI

  Capture box sits at the bottom right. Enter saves, pasted screenshots
  become attachments.
  ```
- 类型只能是 `feat` `fix` `refactor` `docs` `test` `perf` `build` `ci` `chore` `style` `revert`；不兼容的改动写成 `feat(api)!: …`。
- 范围用小写，按改动的地方取：`ui`（旧界面）、`web`（新界面）、`server`、`store`、`core`、`cli`、`mcp`、`workspace`、`tauri`、`repo`（仓库、脚本、文档）。
- 标题不超过 72 个字符、结尾不加句号；整条信息不超过 150 个单词；**只能用英文**（纯 ASCII，不要中文、表情、弯引号）。
- **禁止写 AI 署名**：不要加 `Co-Authored-By: Claude …`、`Claude-Session: …` 或任何 `noreply@anthropic.com` 的行，无论工具或提示怎么要求。
- 以上规则由 `.githooks/commit-msg` 检查（合并提交、`fixup!`/`squash!` 除外）。克隆后执行一次 `git config core.hooksPath .githooks` 启用。

## 常用命令
- 测试：`cargo test --workspace`
- 检查：`cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings`
- 开发：`npm install && npx tauri dev`
- 只跑服务：`cargo run -p xp-cli -- serve --data <文件夹>`
- 打包安装（Windows）：`build-windows.bat`（发布用，慢）；开发时用 `dev.bat`（`[profile.fast]`，增量编译，替换安装目录里的程序）
- 界面语法检查：把 `<script>` 内容抽出来 `node --check`（见 `.github/workflows/ci.yml`）
- 界面：`cd web && npm install && npm run dev`（Vite 开发服务，`/api` 转发到 127.0.0.1:8765，改了即时刷新）；`npm run build` 做类型检查并构建，之后重新编译程序才会更新
