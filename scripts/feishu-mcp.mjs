#!/usr/bin/env node
// 飞书 MCP 的启动器：从 ~/.feishu/app.json 读 app_id、app_secret，再启动飞书官方的 MCP（@larksuiteoapi/lark-mcp）。
// 这样密钥只放在 app.json 里，不用写进 Claude Code 的配置文件。说明见 docs/feishu.md。
//
//   node scripts/feishu-mcp.mjs login          用自己的飞书账号授权一次（浏览器里点同意），之后读写的是你自己能看到的文档
//   node scripts/feishu-mcp.mjs                作为 MCP 服务运行（给 Claude Code 用：claude mcp add feishu -s user -- node <本文件的完整路径>）
//   node scripts/feishu-mcp.mjs -t preset.light   后面的参数原样交给 lark-mcp，会替换掉默认的工具集
//
// 环境变量：FEISHU_APP_JSON 换一个凭据文件；FEISHU_DOMAIN=https://open.larksuite.com 用国际版 Lark。
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const file = process.env.FEISHU_APP_JSON || join(homedir(), ".feishu", "app.json");
let cfg;
try {
  cfg = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
} catch (e) {
  console.error(`读不到飞书凭据 ${file}：${e.message}`);
  process.exit(1);
}
const id = cfg.app_id || cfg.appId;
const secret = cfg.app_secret || cfg.appSecret;
if (!id || !secret) {
  console.error(`${file} 里要有 app_id 和 app_secret`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const login = argv[0] === "login";
const rest = login ? argv.slice(1) : argv;
const domain = process.env.FEISHU_DOMAIN ? ["--domain", process.env.FEISHU_DOMAIN] : [];
// 默认：用你自己的身份（user_access_token），只开文档相关的工具（搜索、读正文、导入成新文档、知识库、给文档加协作者）
const defaults = login ? [] : ["--oauth", "--token-mode", "user_access_token", ...(rest.includes("-t") || rest.includes("--tools") ? [] : ["-t", "preset.doc.default"])];
const args = ["-y", "@larksuiteoapi/lark-mcp", login ? "login" : "mcp", "-a", id, "-s", secret, ...domain, ...defaults, ...rest];

// Windows 上 npx 是 npx.cmd，要经过 shell 才能启动；参数里没有空格和引号，直接拼没问题
const win = process.platform === "win32";
const child = spawn("npx", args, { stdio: "inherit", shell: win, windowsHide: true });
child.on("error", (e) => {
  console.error(`启动 npx 失败（装了 Node.js 吗？）：${e.message}`);
  process.exit(1);
});
child.on("exit", (code, sig) => process.exit(code ?? (sig ? 1 : 0)));
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => child.kill(s));
