# 开发说明（给 AI 编程助手和贡献者）

给人看的开发指南（环境、设计规则、测试、换电脑）在 `docs/development.md`，密码库的说明在 `docs/vault.md`，当前进度、已知问题和待办在 `docs/progress.md`。
开始工作前先看这两篇；做完一批改动后更新 `docs/progress.md`。

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
- 项目：和分类是两个维度（分类 = 这是什么东西，项目 = 这是为哪件事做的）。项目本身是一条 `type = "project"` 的条目
  （`title` 名称、`body` 说明、`keywords`、`status: active|paused|done`、`dirs: [{deviceId, hostname, path}]` 各台电脑上的文件夹），所以和别的条目一样同步。
  别的条目用 `project` 写项目的 id（`"none"` = 明说不属于）；没写的按关键词算出来（标题、标签、分类，再看正文），不落库——见 `web/src/lib/projects.ts` 的 `projectOf`。
  密码库的条目同理（`project` 在密文里，`secretProject`）。界面 `web/src/components/Projects.tsx`（首页顶上的项目栏、条目上的项目标签、新建 / 编辑）。
  `ui.proj` 是全局的范围：首页、各页面的列表、密码库都跟着它；这时新建的条目直接归这个项目。交给 AI 时所属项目当成一条关联材料带上，默认在项目文件夹里干活。
  列条目的地方记得排除 `type = "project"`。
  右键菜单：`web/src/components/ItemMenu.tsx`，整个页面统一接右键；条目的那一行加 `data-item-id` 就有菜单（归到项目、完成、置顶、优先级、截止、分类、转成、交给 AI、删除）。
- 交给 AI 之前先讨论：条目的 `brief`（`{agent, status: asking|ready|done, rounds:[{at, note, questions:[{id,q,why,options,a}]}], plan, feedback, resultId}`）。
  逻辑在 `web/src/lib/brief.ts`（提示词、解析 AI 回的 JSON、整理成 Markdown），界面在 `web/src/components/Brief.tsx`（这一条下面的讨论面板、「交给 AI」先选怎么交）。
  桌面版用 `ask_ai` 叫本机的 AI（claude -p），和评论里 @AI 是同一条路；叫 claude 时自动把 xpanel 的 MCP 接上并放行它的工具（`agent.rs` 的 `with_mcp`，配置写在工作目录的 `.xpanel/mcp.json`，地址和 `xp` 的位置由 `lib.rs` 的 `mcp_link` 给），提示词里告诉它有这些工具；本机文件和命令的权限没放开，仍按 claude 非交互模式的默认；浏览器里或没配 AI 时走手动（复制提示词、贴回复）。开工的产出存成笔记，以「产出」关联回来。
  导出上下文：`web/src/lib/exportContext.ts` 在界面里打一个 zip（README、task.md、discussion.md、comments.md、related/、files/），桌面版用 `save_download` 存到「下载」文件夹。
- 关联：条目的 `links: [{id, label?}]`（发起方存，另一边显示「关联了这条」）；正文里 `[标题](xpanel:item/ID)` 是引用（编辑器里输入 `[[`）。
  界面 `web/src/lib/links.ts` + `web/src/components/Related.tsx`。评论里 @AI 时关联条目的内容和附件一起给 AI；AI 的回答可以「存为笔记」并以「产出」关联回来。
- 多台电脑同时改：界面改字段用 `patch` 操作（`xp-core` 的 `Op::Patch`，只发改动的字段，在主机的最新内容上合并）；
  编辑器保存标题、正文时带 `expect`（这边最后同步到的内容），主机上对不上就返回冲突（409），界面提示「用对方的 / 用我的 / 两份都留」，不会静默覆盖。
- 子笔记：条目的 `parentId` 指向父笔记（笔记、规范）。找不到父笔记就当顶层；删除父笔记时子笔记挪到上一层（`xp-store` 的 `soft_delete`）。
  界面 `web/src/lib/tree.ts` + `web/src/components/Tree.tsx`（路径、子笔记列表、移动到…、列表里拖动改层级）。
- 备份和外置硬盘同步（换电脑）：`xp-store/src/backup.rs`（每日备份、冷备份、一键备份 `backup_to_drive` 写到外置硬盘文件夹的 `xpanel-backup/` + `latest.json`）
  + `xp-store/src/sync.rs`（每个数据文件夹一个 `replica_id`，条目 `origin` 列记在哪改的；同步点 `sync/base.db`；本机 / 外置硬盘 / 同步点三方对比，按条目合并，冲突逐条选）。
  接口 `/api/v1/backup`、`/api/v1/backup/merge`；界面 `web/src/dialogs/DriveSync.tsx`（`lib/api.ts` 的 `drive`，桌面版和浏览器都能用）；
  外置硬盘上的文件夹是桌面版配置的 `syncDir`（命令 `set_sync_dir` → `Store::set_drive_dir`，没设置时用冷备份位置）；命令行 `xp sync`、`xp serve --drive`。说明见 `docs/drive-sync.md`。
- 密码库：`xp-store/src/vault.rs`（表 `vault_keys`、`secrets`，**只存密文**，和条目分开；修改带 `expect`；AI 的取用请求只在内存里；外置硬盘合并 `merge_vault`）
  + `xp-server/src/vault.rs`（`/api/v1/vault/*`）+ 界面 `web/src/lib/vault.ts`（加解密都在界面里：scrypt + XChaCha20-Poly1305，用纯 JS 的 @noble 库，
  因为局域网的明文 HTTP 页面没有 `crypto.subtle`）和 `web/src/components/Vault.tsx`（整页 + AI 取用的确认弹窗 `VaultRequests`）
  + MCP `xp-cli/src/vault.rs`（`xpanel_vault_list` 只有名称；`xpanel_vault_get` 要用户点允许，内容用临时 X25519 公钥加密后经主机转交）。
  随手记：快速记录选「密码」/ 收件箱里的提醒 / 消息工具栏的「密码库」→ `dropSecret`（用钥匙的公钥加密，锁着也能存，`kind = raw` 待整理）→ 之后在密码库里「整理」
  （`lib/vaultParse.ts` 拆各栏）；转入的收件箱消息用 `scrub_item` 真的抹掉。搜索在本机做：`lib/vaultSearch.ts`，入口是全局搜索 `components/Palette.tsx`（Ctrl+K）。
  种类和各栏定义在 `lib/vault.ts` 的 `SPECS`（银行分手机银行 / 信用卡，`sub` 在密文里）；平台预设和 logo 在 `lib/platformData.ts` / `lib/platforms.ts`（`platform`、`label` 在密文里，同平台两个以上账号排成一组）；页面是一整屏的密集列表，点格子复制、点名称展开，编辑是弹窗不常驻。
  规矩：主密码和明文不发给主机、不进日志和操作记录；密码库的内容不要接进条目、搜索、导出、@AI 上下文、项目目录；
  写操作都要过 `check_mac`（只有解锁了的界面算得出校验值）；界面解开后只认密文里的名称，不认主机上的 `title` 列。说明和安全边界见 `docs/vault.md`，改之前先看。
- `crates/xp-cli`：`xp` 命令行，走 `/api/v1`；`xp key` 和 `xp serve` 直接读写数据文件夹。
- `src-tauri`：桌面版。主机模式用 xp-store + xp-server；连接模式（`client.rs`）读写主机的 v1 接口，离线队列 `pending.json`。
- `web/`：界面（Vite + React 19 + TypeScript + Tailwind v4 + Radix），构建到 `web/dist`。桌面版直接用它（`tauri.conf.json` 的 frontendDist，`beforeBuildCommand` 先构建），
  xp-server 把它编进程序挂在 `/`（`crates/xp-server/src/web.rs`，rust-embed；调试构建直接读磁盘上的 dist）。
  - `src/components/`：Sidebar（左侧窄栏，只有图标）、Home（首页：各种内容按要紧程度排好的一整页，打开默认在这；各块的位置和大小可以拖，`HomeGrid.tsx` + `lib/grid.ts`，布局记在本机的 `wb-home-layout`，加新的一块要在 `LAYOUT` 里补默认位置）、Filters（列表上方的分类 / 标签 / 设备筛选）、ListPane、Reader（含右侧浮出面板 Peek）、Inbox、Capture、Global（横幅、选中文字后的评论浮窗、全局粘贴/拖放、快捷键）、
    BlockEditor（所见即所得的块编辑器，TipTap；扩展和 Markdown 读写在 `lib/editor.ts`，正文仍存 Markdown）、Comments、Tree
  - `src/dialogs/`：交给 AI（含任务模板）、设置、设备、分类和标签、微信导入 / 聊天设置 / 追加到笔记
  - 全局搜索：`components/Palette.tsx`（Ctrl+K / 左上的放大镜 / 首页顶上的搜索框）。条目和密码库在本机搜、共用 `lib/search.ts` 的打分（容错、多个词、按栏加权），
    聊天记录走主机的 `/inbox/messages?q=`。加了新的内容类型要接进来。
  - `src/lib/qa.ts`：评论定位（rehype 插件给原文加 `<mark>`）；`lib/ws.ts`：项目目录同步；`lib/drafts.ts`：输入框草稿和待发送附件
  - `src/lib/api.ts` 是唯一的传输层：桌面版走 Tauri 命令（读写条目仍用 `get_state`/`apply_op`，保留连接模式的离线队列），浏览器走 HTTP。
  - `src/lib/data.ts`：TanStack Query 缓存全部条目，写入先改本地再提交；`src/lib/store.ts`：zustand 界面状态。
  - 颜色只用 `src/index.css` 里的设计变量（`bg-surface`、`text-muted`、`bg-accent-soft`…），浅色/深色各一套，不在组件里写色值。
- 图标：`[x]`（Markdown 里勾掉的待办）。源文件 `src-tauri/icons/icon.svg`，改了之后跑 `python3 scripts/make-icons.py` 重新生成各个尺寸（任务栏、安装包、macOS）；
  界面里的是 `web/src/components/ui.tsx` 的 `Logo`，网页标签页的在 `web/index.html`，三处是同一个图形。
- `ui/index.html`：旧界面（单文件原生 JS），挂在 `/old/`，只修严重问题，新功能只做在 `web/`。

## 约定
- 界面同时跑在两种环境：桌面版（`window.__TAURI__` 存在，走 `invoke`）和浏览器（走 `/api/*`）。新功能两边都要考虑。
- 改旧界面（`ui/index.html`）时把 `<meta name="wb-ui-version">` 加 1。
- 条目是自由 JSON（`id/type/title/body/tags/category/device/done/pinned/createdAt/updatedAt/priority/due/rank/doneAt/createdBy/agentLog`，
  以及 `parentId`、`links`、`qa`、`workspaces`、`agentProgress`、`project`、`brief`），按 `id` 合并。界面改字段用 `patchItem`（patch 操作），不要整条 upsert 覆盖已有条目。
- 错误分四类（`StoreError`）：`Invalid` → 400（客户端不重试）、`NotFound` → 404、`Conflict` → 409（别处刚改过，让用户选）、
  `Unavailable` → 503（客户端留着稍后重试）。别把请求本身的问题报成 503。
- 界面设计规则（用户定的，详见 `docs/development.md`）：不用线条和边框分区，层次只靠底色；主按钮墨色、不用蓝色，点缀色赭石只用在很少的地方；
  阴影只给浮起来的东西；宽屏正文居中；小按钮悬浮，不单独占列。
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
- 界面类型检查和构建：`npm --prefix web run build`
- 开发：`npm install && npx tauri dev`
- 只跑服务：`cargo run -p xp-cli -- serve --data <文件夹>`
- 打包安装（Windows）：`build-windows.bat`（发布用，慢）；开发时用 `dev.bat`（`[profile.fast]`，增量编译，替换安装目录里的程序）
- 界面语法检查：把 `<script>` 内容抽出来 `node --check`（见 `.github/workflows/ci.yml`）
- 界面：`cd web && npm install && npm run dev`（Vite 开发服务，`/api` 转发到 127.0.0.1:8765，改了即时刷新）；`npm run build` 做类型检查并构建，之后重新编译程序才会更新
