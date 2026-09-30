# xpanel · 个人工作台

一个自托管的个人工作台：待办、问题、灵感、Markdown 笔记、常用入口（共享文件夹、内网服务、网站）都放在一个地方，
多台电脑共用一份数据，外部 AI 可以通过接口读写，还能一键把事项交给本机的 AI 命令行工具处理。

A self-hosted personal dashboard for todos, issues, ideas, Markdown notes and entry points.
One machine stores the data (SQLite); other machines, browsers and AI agents connect to it over the LAN.
Built with Tauri 2 (Rust). External AI tools can read and write through a REST API (`/api/v1`, OpenAPI) and the `xp` CLI.

## 功能

- **收件箱**：像发消息一样把想到的、截的图直接发进来（输入框在最下面，回车发送），之后鼠标移上去一键归到待办、问题、灵感、笔记或入口；也可以多选合成一篇笔记。
- **微信聊天记录**：微信里多选消息 → 合并转发 → 导出，把 ZIP 拖进来就导入（同一个群多次导出，重复的消息自动跳过，图片按内容只存一份）。按聊天查看，选中消息后存成笔记、转成待办、复制 Markdown 或交给 AI；每个聊天记着「已处理到哪」，下次只看新的。
- **事项**：待办 / 问题 / 灵感三栏，置顶的进入「当前焦点」；优先级（P0–P3）和截止日期（日期选择器，或记录时写 `!1 ~明天`），按优先级和截止日期排序。
- **分类和标签**：每条可以放进一个分类（用 `/` 分层，如 `工作/AutoSAR`），再打多个标签；笔记页左侧是分类树和标签，其他页用工具栏筛选。分类和标签可以改名、移动、合并、删除，正在看某个分类时新建的条目会自动放进去。
- **笔记**：Markdown 编辑与预览，任何地方 Ctrl+V 截图都会自动保存；图片大小可以在阅读模式里选或拖动调整（写法和 Obsidian 一样：`![说明|480](…)`）。写好后可以「归类」成待办、问题等。
- **设备**：每台电脑一条记录（名称、类型、描述、别名、各局域网里的地址、项目），装了桌面版的电脑每分钟上报在线状态、当前 IP 和装了哪些 AI 命令行。记录时写 `@设备名` 就能关联。
- **入口**：按机器自动分组（`\\主机\共享`、`http://内网IP`、网站、本机磁盘），桌面版一键打开。
- **笔记展开成项目**：交给 AI 时可以把一条笔记展开成一个项目文件夹（默认 `D:\codes\<项目名>`，项目名按标题自动起，比如 leap-motor-code），
  AI 以它为工作目录干活：`.xpanel/` 里放任务说明、笔记原文、按编号排好的截图，根目录是正常的项目。之后往笔记里继续贴内容和截图，
  这台电脑上的 xpanel 会自动同步进去（截图编号固定，新图往后编），点「继续」时只告诉 AI 新增了什么。
  AI 通过 MCP 回写进展，显示在条目的「AI 进展」里。任务模板（通用、从截图复刻项目、整理聊天记录、排查问题）可以自己改。
- **块编辑**：笔记像飞书文档一样按块编辑：所见即所得，`/` 插入标题、列表、待办、代码、表格、图片；块左边的手柄可以拖动、复制、转换、删除。
  正文仍然存成 Markdown，也可以切到「Markdown」直接改源码。代码块、行内代码、路径、列表卡片都能一键复制。
- **子笔记**：笔记可以分层：在笔记里「新建子笔记」，或者「移动到…」/ 在列表里拖到另一篇上。删除父笔记时子笔记挪到上一层。
- **关联**：任意两条可以互相关联并写个标签（岗位、简历、题库、流程、工具…），正文里输入 `[[` 可以直接引用另一篇。
  在评论里 @AI 时，关联的内容（包括简历 PDF、截图等附件）会一起交给 AI；回答可以一键存成笔记并关联回来。
- **多台电脑同时编辑**：只改动的字段会发给主机；两边同时改了同一篇的正文时会提示选择留哪份（或两份都留），不会被空内容或旧内容覆盖。
- **评论和 @AI**：每篇笔记下面有评论区；选中正文里的字也能单独评论。评论里 `@Claude Code`、`@Codex` 等设定好的 AI，
  它会读完这篇笔记在评论里回答（`claude -p`，不开窗口），可以接着回复、标记解决、整理成一篇新笔记。
  被评论的原文淡色高亮，位置按「原话 + 前后文」记，之后往笔记里插内容也找得回来；评论内容能被搜索到。
- **交给 AI**：任意条目一键交给 Claude Code、Codex 等命令行工具（新终端窗口），或在浏览器打开 ChatGPT；命令可自定义。
- **对外接口**：外部 AI 可以写入待办、整理优先级、导出、做统计分析，每次修改都记录是谁改的。
- **多机共用**：一台「主机」存数据并在局域网开放；其他电脑选「连接到主机」，浏览器直接访问 `http://主机:8765`。
- **离线可用**：连接模式下连不上主机时照常能看、能记，恢复后自动补传；主机暂时存不了时改动也不会丢。
- **外置硬盘同步**：左下角硬盘图标（或「设置 → 外置硬盘同步」）把整份数据（数据库和附件）和外置硬盘上的文件夹同步，
  谁在上次同步后改过就用谁的；两边都改过时让你选，被覆盖的一边先备份。出差时硬盘插到别的电脑（Windows / Mac），
  把那台的数据文件夹设成硬盘上的文件夹即可；回来再同步一次。命令行：`xp sync --data D:\xpanel F:\xpanel`。详见 [docs/drive-sync.md](docs/drive-sync.md)。
- **备份**：每天自动备份数据库到 `backups/`，保留 60 份；可再设一个冷备份文件夹（比如大容量硬盘），每天复制一份过去。

## 对外接口（给 AI 和脚本）

主机开着时，接口文档在 `http://主机:8765/api/v1/openapi.json`，把这个地址交给 AI 就能自己学会用。

```bash
# 在主机上为某个 AI 生成一把 key（只显示一次）
xp key create claude-code --data D:\xpanel

# 写入待办
curl -X POST http://主机:8765/api/v1/items \
  -H "Authorization: Bearer $XPANEL_KEY" -H "Content-Type: application/json" \
  -d '{"title":"整理客户反馈","priority":"P1","tags":["客户"],"due":"2026-10-08"}'

# 查询未完成的待办和问题
curl "http://主机:8765/api/v1/items?type=todo,issue&status=open"

# 批量调整优先级：先 dryRun 看对比，确认后再提交
curl -X POST http://主机:8765/api/v1/items/reprioritize -H "Content-Type: application/json" \
  -d '{"dryRun":true,"changes":[{"id":"…","priority":"P0","reason":"客户在催"}]}'

# 导出（md 适合交给 AI 读，csv 给表格，json 给程序）和统计
curl "http://主机:8765/api/v1/export?format=md&status=open"
curl "http://主机:8765/api/v1/stats"
```

| 接口 | 用途 |
| --- | --- |
| `GET/POST /api/v1/items` | 查询（类型、状态、标签、优先级、关键词）/ 新建（单条或数组；带 `id` 即幂等） |
| `GET/PATCH/DELETE /api/v1/items/{id}` | 读取 / 按字段修改 / 删除（软删除） |
| `POST /api/v1/items/reprioritize` | 批量调整优先级和排序，支持 `dryRun` |
| `GET /api/v1/export` | 导出 md / csv / json |
| `GET /api/v1/stats` | 各类型数量、优先级分布、逾期、长期未动、最近 8 周趋势 |
| `GET /api/v1/audit` | 操作记录：谁在什么时候改了什么 |
| `GET/POST/DELETE /api/v1/categories`、`POST /categories/rename` | 分类列表（带数量）、新建、改名 / 移动、删除 |
| `GET/DELETE /api/v1/tags`、`POST /tags/rename` | 标签列表、改名 / 合并、删除 |
| `GET/POST /api/v1/devices`、`PATCH/DELETE /api/v1/devices/{id}` | 设备列表与维护（改名时条目里的设备名一起改） |
| `POST /api/v1/inbox/wechat/preview`、`/inbox/wechat/import?chat=` | 预览 / 导入微信聊天记录 ZIP（请求体直接发 ZIP，或 JSON `{data: base64}`） |
| `GET /api/v1/inbox/chats`、`PATCH/DELETE /inbox/chats/{id}` | 聊天列表（消息数、未处理数）；改名（同名即合并）、设「已处理到」、删除 |
| `GET /api/v1/inbox/messages`、`GET /inbox/markdown` | 查消息（聊天、关键词、时间、只看未处理）；导出成 Markdown 交给 AI |
| `POST /api/v1/inbox/messages/to-item` | 选中的消息整理成一条笔记或待办 |
| `POST /api/v1/items/{id}/progress` | AI 回写进展（进行中 / 完成 / 卡住） |
| `POST /api/v1/items/{id}/qa` | 往笔记上挂一条问答（quote 原样摘抄原文） |
| `GET/PUT /api/v1/templates` | 交给 AI 的任务模板 |
| `GET /api/v1/events` | SSE，数据变化时推送 |

## 接入 AI：MCP

装好桌面版后 `xp` 命令就在 PATH 里，`xp mcp` 是一个 MCP 服务，Claude Code、Codex 等支持 MCP 的 AI 在任何项目里都能直接读写 xpanel：
查 / 建 / 改 / 完成 / 删除条目、批量调优先级（先预览再提交）、导出和统计、看分类标签和设备、往收件箱发东西、
读微信聊天里没处理过的消息、把消息存成笔记或待办、标记已处理；在笔记展开的项目里同步最新笔记（`xpanel_workspace_sync`）、
回写进展（`xpanel_report`），也能自己把一条笔记展开成项目（`xpanel_workspace_create`），或者把概念解释挂到笔记原文旁边（`xpanel_add_qa`）。每次修改都记在操作记录里，写明是哪个 AI 改的。

```bash
# Claude Code（-s user：所有项目都能用）
claude mcp add xpanel -s user -e XPANEL_URL=http://主机:8765 -e XPANEL_KEY=xp_… -- xp mcp
```

```toml
# Codex：~/.codex/config.toml
[mcp_servers.xpanel]
command = "xp"
args = ["mcp"]
env = { XPANEL_URL = "http://主机:8765", XPANEL_KEY = "xp_…" }
```

- `XPANEL_URL`：主机地址；在主机本机上用 `http://127.0.0.1:8765`（需要在设置里勾选「在局域网开放」，或用 `xp serve` 跑服务）。
- `XPANEL_KEY`：可选，在主机上用 `xp key create claude-code` 生成，操作记录里就会写「claude-code」；不填时记为「mcp」，也可以用 `XPANEL_ACTOR` 起个名字。
- MCP 直接连主机，主机连不上时会返回错误（不像桌面版有离线队列）。

## 命令行 `xp`

```bash
export XPANEL_URL=http://主机:8765 XPANEL_KEY=xp_…   # Windows 用 $env:XPANEL_URL = "…"
xp add 写周报 -p P1 --tag 周报 --due 2026-10-08 -c 工作/周报
xp ls -s open -t todo,issue
xp done <id>
xp set <id> priority=P0 due=2026-10-10
xp export -f md -s open > todo.md
xp stats
xp import 聊天记录_20260929.zip --chat 项目群   # 导入微信聊天记录
xp chat 项目群 --unread --mark-read > 新消息.md  # 没处理过的消息导出成 Markdown，并标为已处理
xp workspace create <条目id> --template rebuild   # 把笔记展开成项目（默认 D:\codes 或 ~/codes 下）
xp workspace prompt                     # 在项目里：同步最新笔记，输出交给 AI 的提示词（只说新增了什么）
xp report "还原了 3 个文件" --status working   # 在项目里：回写进展
xp serve --data /srv/xpanel            # 无窗口运行（Linux 主机、Docker）
```

每个命令加 `--json` 输出结构化结果，方便 AI 解析。

## 构建

需要 [Rust](https://rustup.rs)、[Node.js](https://nodejs.org)；Windows 另需 Visual Studio Build Tools（C++ 桌面开发）。

- Windows：双击 `build-windows.bat`，会打包并安装到 `%LOCALAPPDATA%\Programs\xpanel`（`xp` 命令加入 PATH），首次运行自动创建桌面快捷方式。
- macOS：`bash build-mac.sh`
- 改了代码想快点用上：双击 `dev.bat`（Windows），用快速编译配置编出 xpanel.exe 和 xp.exe，替换安装目录里的程序并重新打开。
  第一次要编译所有依赖，几分钟；之后一般几秒到几十秒。
- 开发：`npm install && npx tauri dev`
- 只改界面：程序（或 `xp serve`）照常跑着，在 `web/` 里 `npm install && npm run dev`，打开它给出的地址，保存即刷新，不用编译 Rust。
  打包时 `tauri build` 会先构建 `web/`；`dev.bat` 也会。
- 旧界面（单文件）还留在 `http://主机:8765/old/`，新界面有问题时可以先用它。
- 测试：`cargo test --workspace`

代码结构：

```
crates/
  xp-core     条目模型、优先级、导出、统计、微信聊天记录解析（纯逻辑）
  xp-store    SQLite、迁移、备份、附件、全文搜索、API key、操作记录、导入的聊天
  xp-server   HTTP 服务：旧版兼容接口 + /api/v1 + SSE
  xp-workspace 笔记展开成项目目录、同步、「继续」的提示词
  xp-cli      xp 命令行、MCP 服务（xp mcp）
src-tauri/    桌面版（Tauri）
web/          界面（React + TypeScript + Tailwind）
ui/           旧界面（单文件），挂在 /old/
```

## 使用

首次打开选择角色：

- **这台电脑存数据（主机）**：填一个数据文件夹，勾选「在局域网开放」。Windows 防火墙询问时允许「专用网络」。
- **连接到主机**：填 `http://主机名或IP:8765`。

数据文件夹里：`xpanel.db`（数据库）、`assets/`（图片和附件）、`backups/`（每日备份）。
从旧版升级时，旧的 `workbench.json` 会自动导入，并改名为 `workbench.v1.json` 保留。

## 更新

- **改了界面**：在 `web/` 里 `npm run dev` 边改边看；改完运行 `dev.bat` 编进桌面版和网页服务。
- **旧界面**（`/old/`）：把新的 `ui/index.html`（`wb-ui-version` 版本号更高）放进主机数据文件夹的 `ui/` 里就会换上。
- **改了程序本身**：推送 `v*` 标签后，GitHub Actions 会自动打包 Windows 和 macOS 版本并发布到 Releases。

## 安全说明

局域网网页服务和接口**没有登录验证**（API key 目前只用来区分是谁改的），任何能访问到这个端口的人都能读写数据。
只在可信的局域网里使用，不要把端口映射到公网；需要在外网访问时，请用 Tailscale / WireGuard 等组网工具。

## 许可证

MIT

内置第三方库：[marked](https://github.com/markedjs/marked)（MIT）、[DOMPurify](https://github.com/cure53/DOMPurify)（Apache-2.0 / MPL-2.0），许可信息保留在 `ui/vendor/` 文件头部。
