@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === 快速编译并替换 xpanel（开发用） ===
echo 不做完整优化：第一次要编译所有依赖，几分钟；之后改了代码一般几秒到几十秒。
echo 正式发给别人用的版本请用 build-windows.bat。
echo.
where cargo >nul 2>&1 || (echo 没找到 Rust，请先安装：https://rustup.rs & pause & exit /b 1)
where npm >nul 2>&1 || (echo 没找到 Node.js，请先安装：https://nodejs.org & pause & exit /b 1)
rem 新界面（React，/next/）：没有 node_modules 时先安装依赖
if not exist "web\node_modules" (call npm --prefix web install || (pause & exit /b 1))
call npm --prefix web run build
if errorlevel 1 (echo. & echo 新界面构建失败，把上面的报错发给 Claude。 & pause & exit /b 1)
cargo build --profile fast -p xpanel --features tauri/custom-protocol
if errorlevel 1 (echo. & echo 编译失败，把上面的报错发给 Claude。 & pause & exit /b 1)
cargo build --profile fast -p xp-cli
if errorlevel 1 (echo. & echo 编译失败，把上面的报错发给 Claude。 & pause & exit /b 1)
set "DEST=%LOCALAPPDATA%\Programs\xpanel"
if not exist "%DEST%" mkdir "%DEST%"
taskkill /im xpanel.exe /f >nul 2>&1
rem 刚关掉的进程可能还占着文件，稍等一下
timeout /t 1 /nobreak >nul
copy /y "target\fast\xpanel.exe" "%DEST%\xpanel.exe" >nul
if errorlevel 1 (echo 替换 xpanel.exe 失败：它可能还在运行，关掉后再运行一次 dev.bat & pause & exit /b 1)
copy /y "target\fast\xp.exe" "%DEST%\xp.exe" >nul
if errorlevel 1 echo 提示：xp.exe 正在被使用（可能是 Claude Code 等 AI 开着 xpanel 的 MCP），这次没替换，关掉它们后再运行一次即可。
echo.
echo 已替换 %DEST% 里的程序，正在重新打开 xpanel…
start "" "%DEST%\xpanel.exe"
