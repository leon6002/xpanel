@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === 打包并安装 xpanel ===
where cargo >nul 2>&1 || (echo 没找到 Rust，请先安装：https://rustup.rs & pause & exit /b 1)
where npm >nul 2>&1 || (echo 没找到 Node.js，请先安装：https://nodejs.org & pause & exit /b 1)
call npm install || (pause & exit /b 1)
rem 新界面（React，/next/）：没有 node_modules 时先安装依赖
if not exist "web\node_modules" (call npm --prefix web install || (pause & exit /b 1))
call npm --prefix web run build
if errorlevel 1 (echo. & echo 新界面构建失败，把上面的报错发给 Claude。 & pause & exit /b 1)
call npx tauri build --no-bundle
if errorlevel 1 (
  echo.
  echo 打包失败。如果报错里有 link.exe，需要先装 Visual Studio Build Tools 的「使用 C++ 的桌面开发」。
  echo 其他报错把上面的内容发给 Claude。
  pause & exit /b 1
)
cargo build --release -p xp-cli
if errorlevel 1 (pause & exit /b 1)
set "DEST=%LOCALAPPDATA%\Programs\xpanel"
if not exist "%DEST%" mkdir "%DEST%"
taskkill /im xpanel.exe /f >nul 2>&1
rem 旧版程序也关掉，免得它继续写旧的 workbench.json
taskkill /im workbench.exe /f >nul 2>&1
copy /y "target\release\xpanel.exe" "%DEST%\xpanel.exe" >nul
copy /y "target\release\xp.exe" "%DEST%\xp.exe" >nul
rem 把安装目录加进用户 PATH（只加一次），之后任何终端里都能用 xp 命令
powershell -NoProfile -Command "$d=$env:DEST; $p=[Environment]::GetEnvironmentVariable('Path','User'); if(-not $p){$p=''}; if(($p -split ';') -notcontains $d){[Environment]::SetEnvironmentVariable('Path', (($p.TrimEnd(';') + ';' + $d).TrimStart(';')), 'User'); Write-Host ('已把 ' + $d + ' 加入 PATH，新开的终端里可以直接用 xp')}"
if not exist dist mkdir dist
copy /y "target\release\xpanel.exe" "dist\xpanel.exe" >nul
copy /y "target\release\xp.exe" "dist\xp.exe" >nul
echo.
echo 已安装到 %DEST%
echo 第一次打开会自动在桌面放 xpanel 快捷方式；旧的「我的工作台」快捷方式可以删掉。
echo 设置会从旧版自动带过来；数据文件夹里的 workbench.json 会自动导入并改名为 workbench.v1.json。
echo 要给别的电脑用：把 dist 里的 xpanel.exe（和 xp.exe）拷过去即可。
start "" "%DEST%\xpanel.exe"
pause
