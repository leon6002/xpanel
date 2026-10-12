# 接入飞书（MCP）

让 Claude Code（终端里开的，和 xpanel「交给 AI」、评论里 @AI 叫起来的）能搜索、读取你的飞书文档，把写好的 Markdown 导入成新的飞书文档。
用的是飞书官方的 MCP（`@larksuiteoapi/lark-mcp`），由 `scripts/feishu-mcp.mjs` 启动：它从 `~/.feishu/app.json` 读应用凭据，
所以 app_secret 只放在那个文件里，不进 Claude Code 的配置，也不进仓库。

## 能做什么、不能做什么

默认只开文档相关的工具（`preset.doc.default`）：

| 工具 | 做什么 |
|---|---|
| `docx_builtin_search` | 搜索文档 |
| `docx_v1_document_rawContent` | 读一篇文档的正文 |
| `docx_builtin_import` | 把 Markdown 导入成一篇**新的**飞书文档 |
| `wiki_v1_node_search`、`wiki_v2_space_getNode` | 搜索知识库、读知识库节点（拿到对应的文档） |
| `drive_v1_permissionMember_create` | 给文档加协作者 |

官方 MCP 目前**不能改已有文档的内容**（只能读、搜、导入成新的），所以另外接了社区的 `feishu-mcp`（见下面「改已有文档」）。
它还在 Beta，工具和参数可能会变。想换工具集：`node scripts/feishu-mcp.mjs -t preset.light`（参数原样交给 lark-mcp）。

## 第一次设置

1. **飞书开放平台**（open.feishu.cn → 开发者后台 → 你的应用）：
   - 安全设置 → 重定向 URL 加上 `http://localhost:3000/callback`（授权登录要用）。
   - 权限管理 → 开通要用的「用户身份」权限：云文档（读、导入）、知识库、搜索。只读就只开读的。
   - 创建版本并发布。企业自建应用可能要管理员审核，发布之后权限才生效。
2. **凭据文件**：`C:\Users\<你>\.feishu\app.json`，内容 `{"app_id": "cli_…", "app_secret": "…"}`（已经有了就不用动）。
3. **用你自己的账号授权一次**（浏览器会弹出来，点同意）：
   ```
   node D:\codes\xpanel\scripts\feishu-mcp.mjs login
   ```
   授权后访问的是你自己能看到的文档，不是只能看「分享给应用」的那些。过期了它会自己再提示登录。
4. **加到 Claude Code**（`-s user`：所有项目都能用，xpanel 后台叫起来的 Claude Code 也能用）：
   ```
   claude mcp add feishu -s user -- node D:\codes\xpanel\scripts\feishu-mcp.mjs
   claude mcp list
   ```
   列表里 `feishu` 显示已连接就好了。仓库换了位置，要用新路径重新加一次。

## 改已有文档：社区的 feishu-mcp

[cso1z/Feishu-MCP](https://github.com/cso1z/Feishu-MCP)，第三方开源（MIT），能做官方的做不了的：新建文档、按块读写（改文字、加内容、删内容）、表格、插图片、画板、文件夹。
同一个启动器加 `edit` 就是它，凭据也从 app.json 读（走环境变量，不出现在命令行里）。版本固定在测过的 0.3.2，要换设 `FEISHU_MCP_VERSION`。

1. 飞书开放平台再加一个重定向 URL：`http://localhost:3333/callback`。
2. 权限管理里开通它要的用户身份权限，主要是：`docx:document`、`docx:document:create`、`docx:document:readonly`、`docx:document.block:convert`、
   `docs:document.content:read`、`drive:drive`、`drive:file`、`drive:file:upload`、`space:document:retrieve`、`space:folder:create`、
   `wiki:wiki`、`wiki:space:read`、`search:docs:read`、`offline_access`（完整列表见它仓库里的 FEISHU_CONFIG.md），再发布一个版本。
3. 加到 Claude Code：
   ```
   claude mcp add feishu-edit -s user -- node D:\codes\xpanel\scripts\feishu-mcp.mjs edit
   ```
4. 第一次用它的工具时，它会回一个授权链接（AI 会把链接给你），浏览器里点同意，再让 AI 重试一次。之后就不用了。
   想先授权好：在终端里开 Claude Code，说一句「用 feishu-edit 搜一下飞书文档」，点它给的链接。

它默认用你自己的身份（`FEISHU_AUTH_TYPE=user`）；改成 `tenant` 就是应用身份，那样只能动分享给应用的文档。它要求 Node.js 20.17 以上。

两个一起加也没关系：官方的搜索、读取更稳；要改文档时 AI 会用 `feishu-edit` 的工具。

## 在 xpanel 里用

- 「交给 AI」讨论、开工，或者在评论里 @Claude Code 时，它就能用飞书的工具了。比如：「把这篇笔记导入成飞书文档」「在飞书里找上周的周会纪要，整理成这里的待办」。
- 每次用飞书的工具，xpanel 会弹窗问你（和运行命令一样）。嫌烦就点「以后同类的都允许」，只管这一次任务。
- 国际版 Lark：设置环境变量 `FEISHU_DOMAIN=https://open.larksuite.com`。

## 出问题时

- `claude mcp list` 里 feishu 连不上：在终端里直接跑 `node D:\codes\xpanel\scripts\feishu-mcp.mjs`，看报错（读不到 app.json、没装 Node.js、npx 下载失败…）。
- 提示没有权限：回开放平台看对应的权限开了没有、版本发布了没有，再重新 `login` 一次。
