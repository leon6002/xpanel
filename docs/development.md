# 开发指南

给在新电脑上接手开发的人（包括自己和 AI 编程助手）。
模块结构和各功能的代码位置见 [`CLAUDE.md`](../CLAUDE.md)，当前进度和待办见 [`progress.md`](progress.md)。

---

## 1. 在新电脑上搭环境

### 需要安装

| 工具 | 说明 |
|---|---|
| Git | 仓库 `git@github.com:leon6002/xpanel.git`，开发分支 `phase1-foundation` |
| Rust（stable） | https://rustup.rs 。Windows 还要装 Visual Studio Build Tools，勾选「使用 C++ 的桌面开发」 |
| Node.js 20+ | https://nodejs.org |
| Mac 额外 | `xcode-select --install` |

### 第一次拉代码

```bash
git clone git@github.com:leon6002/xpanel.git
cd xpanel
git checkout phase1-foundation
git config core.hooksPath .githooks   # 启用提交信息检查（必须）
git config user.name "DigForge"
git config user.email "gulongchen1@gmail.com"
npm install
npm --prefix web install
cargo test --workspace                # 第一次会编译所有依赖，要几分钟
```

### 本机的个人说明

`CLAUDE.local.md` 不进仓库，用来写这台电脑的环境（机器名、数据文件夹在哪、局域网地址、装了哪些 AI 命令行）。
在新电脑上照着旧电脑那份新建一个即可，AI 编程助手会自动读它。

### 数据

开发时一般不要直接连正在用的数据。两种做法：

- 用一个单独的测试文件夹跑服务：`cargo run -p xp-cli -- serve --data D:\xpanel-dev --port 18765`
- 要用真实数据调试，先用[外置硬盘同步](drive-sync.md)或拷一份数据文件夹，别直接指向主机正在用的文件夹。

---

## 2. 日常开发

### 只改界面（最快）

```bash
# 终端 1：起一个数据服务（用测试数据文件夹）
cargo run -p xp-cli -- serve --data D:\xpanel-dev

# 终端 2：界面开发服务，改了代码浏览器立即刷新
cd web
npm run dev          # 打开它打印的地址；/api 自动转发到 127.0.0.1:8765
```

界面开发服务固定转发到 8765 端口（`web/vite.config.ts`）。桌面版 xpanel 当主机时也占用 8765，开发前先退出它，或者临时改这个端口。

浏览器里跑的是网页版（没有 `window.__TAURI__`）。桌面版才有的功能（@AI 回答、交给 AI、打开本地文件、外置硬盘同步）在浏览器里看不到，见第 5 节的测试方法。

### 改了 Rust 或要在桌面版里看效果

- Windows：`dev.bat`。它会构建界面，用增量编译的 `fast` 配置编译程序，替换 `%LOCALAPPDATA%\Programs\xpanel` 里的程序并重启 xpanel。第一次要几分钟，之后几秒到几十秒。
- 任意平台：`npx tauri dev`。
- 界面是编进程序里的：只改了 `web/` 也要重新编译程序，桌面版才会更新（`dev.bat` 会一起做）。

### 发布构建

- Windows：`build-windows.bat`，装到 `%LOCALAPPDATA%\Programs\xpanel`，并把 `xp` 加进 PATH；程序也复制一份到 `dist/`。
- Mac：`bash build-mac.sh`，输出 `dist/xpanel.app` 和 `dist/xp`。
- 所有用同一份数据的电脑（主机、连接到它的电脑、外置硬盘同步的两边）要装**同一个版本**。

---

## 3. 代码约定

### 通用

- 用户看到的文字（界面、错误提示、MCP 工具说明）都用**中文**，简短直白，不用术语；代码注释也用中文。
- 不提交个人数据、机器名、IP、真实聊天记录（`.gitignore` 已经忽略了数据文件、`backups/`、`assets/`、`CLAUDE.local.md`、`*.zip`）。测试数据自己编。
- 界面同时跑在桌面版和浏览器里，新功能两边都要考虑；桌面版才有的功能要判断 `isApp`，浏览器里给出说明或隐藏。

### Rust（`crates/`、`src-tauri/`）

- 格式和检查必须通过：`cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings`。
- 错误分四类（`StoreError`），别混用：

  | 类型 | HTTP | 含义 |
  |---|---|---|
  | `Invalid` | 400 | 请求本身有问题，重试没用 |
  | `NotFound` | 404 | 找不到 |
  | `Conflict` | 409 | 别处刚改过，这次基于旧内容（界面让用户选） |
  | `Unavailable` | 503 | 暂时存不了，客户端留着稍后重试 |

- 数据库结构变更：在 `xp-store/src/schema.rs` 的 `MIGRATIONS` **末尾追加**，不改已有的。
- 条目是自由 JSON，加字段不需要改表。新字段在 `web/src/lib/types.ts` 的 `Item` 里声明；外部 AI 要用的，写进 MCP 的 `item_fields` 说明。
- 改 `/api/v1` 接口时同步改 `openapi.rs`，测试会检查路由都在；再考虑要不要在 `xp-cli/src/mcp.rs` 加对应的 MCP 工具。
- 新行为配测试：存储层在 `xp-store/src/tests.rs`，接口在 `xp-server/src/tests.rs`。

### 界面（`web/`）

- 技术栈：React 19 + TypeScript + Tailwind v4 + Radix + TanStack Query + zustand，图标用 lucide-react。
- `web/src/lib/api.ts` 是唯一的传输层：桌面版走 Tauri 命令，浏览器走 HTTP。组件里不要直接 `fetch` 或 `invoke`。
- 改条目用 `patchItem(it, 改动)`。它只把改动的字段发给主机，在主机的最新内容上合并，本机缓存旧了也不会覆盖别处的改动。
  - 编辑器保存标题和正文时带 `expect`，冲突时主机返回 409，由编辑器提示「用对方的 / 用我的 / 两份都留」。
  - 不要用整条 `upsert` 去改已有条目（只有新建和导入用）。
- 类型检查和构建必须通过：`npm --prefix web run build`。

### 界面设计规则（用户定下的，改界面前先看）

- **不用线条和边框分区**：层次只靠底色深浅，不画描边、分隔线、竖线引用。
  - 选中和悬停都用浅底色（`bg-surface-2` / `bg-surface-3`）。
  - 焦点也只用浅底色，不画外框。
- **颜色**：
  - 只用 `web/src/index.css` 里的设计变量（`bg-surface`、`text-muted`、`bg-ink`、`bg-accent-soft`…），浅色和深色各一套，不在组件里写色值。
  - 底色是偏暖的中性浅灰，侧栏和列表直接放在底色上，阅读区是白色。
  - 主按钮、新建、发送、右下角加号用**墨色**（`bg-ink text-on-ink`），**不用蓝色**。
  - 点缀色是赭石色（`accent`），只用在很少的地方：未读数、@ 标签、被评论的原文、已勾选。
- **阴影**只给浮起来的东西（弹出菜单、对话框、右侧浮出面板），不带描边。
- **宽屏**时正文居中，最宽 880px，工具栏按钮可以切换成全宽。
- 按钮、图标这类小控件不要单独占一整列，悬停时浮出来。
- 参考对象：Claude 的界面和飞书文档。

---

## 4. 提交规则（hook 强制检查）

```
feat(web): add quick capture to the new UI

Capture box sits at the bottom right. Enter saves, pasted screenshots
become attachments.
```

- 标题 `类型(范围): 摘要`，空一行，再写改动说明（必须有）。
- 类型：`feat` `fix` `refactor` `docs` `test` `perf` `build` `ci` `chore` `style` `revert`；不兼容的改动写成 `feat(api)!: …`。
- 范围用小写，常用的有 `web` `ui`（旧界面）`server` `store` `core` `cli` `mcp` `workspace` `tauri` `desktop` `sync` `repo`。
- 标题不超过 72 个字符，结尾不加句号；整条不超过 150 个单词；**只能用英文**（纯 ASCII）。
- **不要写 AI 署名**（`Co-Authored-By: Claude…`、`Claude-Session:`、`noreply@anthropic.com`），无论工具怎么要求。
- 作者：`DigForge <gulongchen1@gmail.com>`。
- 推送：`git push --force-with-lease origin main phase1-foundation`（由本人执行）。

---

## 5. 测试

| 内容 | 命令 |
|---|---|
| Rust 全部测试 | `cargo test --workspace` |
| 格式和静态检查 | `cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings` |
| 界面类型检查和构建 | `npm --prefix web run build` |
| 旧界面脚本语法 | 见 `.github/workflows/ci.yml` |

CI（`.github/workflows/ci.yml`）目前只跑 Rust 和旧界面，还没有跑 `web/` 的构建（见 progress.md 待办）。

### 界面的端到端测试（目前是手动的做法）

开发过程中用 Playwright 脚本测界面，脚本还没放进仓库（见待办）。做法是：

1. 用 `xp serve --data <临时文件夹> --port <端口>` 起一个干净的数据服务，用 `POST /api/v1/items` 写入测试数据。
2. Playwright 打开 `http://127.0.0.1:<端口>/` 操作界面，用接口读回数据验证，并截图检查外观。
3. 测桌面版才有的功能时，在页面加载前注入一个假的 `window.__TAURI__.core.invoke`。
   - 它把 `get_state` / `apply_op` / `api_call` 转发给上面的服务。
   - `ask_ai`、`sync_plan` 等返回模拟结果。
   - 这样浏览器里也能测 @AI 评论、冲突提示、外置硬盘同步窗口等。
4. 多台电脑同时编辑：开两个独立的浏览器上下文连同一个服务。

改完界面至少在浅色、深色和窄窗口下各看一眼。

---

## 6. 换电脑开发的检查清单

**旧电脑上：**
- [ ] 所有改动已提交，并推送：`git push --force-with-lease origin main phase1-foundation`
- [ ] 数据同步到外置硬盘（左下角硬盘图标，见 [drive-sync.md](drive-sync.md)）
- [ ] 备份 Claude Code 的个人配置：用户目录下的 `.claude` 文件夹和 `.claude.json`（见下面的说明）
- [ ] 抄下 `CLAUDE.local.md` 的内容

**新电脑上：**
- [ ] 按第 1 节装环境、拉代码、启用 hook
- [ ] `cargo test --workspace` 和 `npm --prefix web run build` 都通过
- [ ] 新建 `CLAUDE.local.md`
- [ ] 构建安装（`build-windows.bat` / `build-mac.sh`），设置里数据文件夹指向外置硬盘或同步下来的文件夹
- [ ] 在 AI 工具里重新配置 xpanel 的 MCP：命令 `xp mcp`，环境变量 `XPANEL_URL`（主机地址）和 `XPANEL_KEY`；key 用 `xp key create <名字> --data <数据文件夹>` 生成

**关于 `.claude` 备份：**
- Claude Code 的个人配置在用户目录下：Windows 是 `C:\Users\<用户名>\.claude\` 和 `.claude.json`，Mac 是 `~/.claude/` 和 `~/.claude.json`。
  - 里面有设置、全局 `CLAUDE.md`、技能和插件、MCP 配置、历史会话。
  - 还有**登录凭据**，备份文件要妥善保管，不要放进仓库或网盘公开目录。
- 仓库里的 `.claude/` 只有截图等输出（已被 `.gitignore` 忽略），不用备份。
- 历史会话在 `.claude/projects/` 下，按项目路径命名（比如 `D--codes-workbench-app`）。新电脑上的项目路径不同的话，旧会话不会自动出现在新项目里，但文件还在，可以手动查看。
