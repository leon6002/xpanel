#!/bin/bash
# 打包 xpanel Mac 版：在 Mac 上运行 bash build-mac.sh
set -e
cd "$(dirname "$0")"
command -v cargo >/dev/null || { echo "没找到 Rust，请先安装：https://rustup.rs"; exit 1; }
command -v npm >/dev/null || { echo "没找到 Node.js，请先安装：https://nodejs.org"; exit 1; }
npm install
# 界面（web/）由 tauri build 先构建（tauri.conf.json 的 beforeBuildCommand）
npx tauri build --bundles app
cargo build --release -p xp-cli
mkdir -p dist
rm -rf "dist/xpanel.app"
cp -R target/release/bundle/macos/*.app "dist/xpanel.app"
cp target/release/xp dist/xp
echo "完成：dist/xpanel.app，命令行工具 dist/xp（可复制到 /usr/local/bin）"
open dist
