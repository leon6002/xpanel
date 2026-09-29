@echo off
rem Release build: builds xpanel and the xp CLI, installs them to %LOCALAPPDATA%\Programs\xpanel and adds xp to PATH.
rem Keep this file ASCII only: cmd misreads UTF-8 batch files with Chinese text after chcp.
chcp 65001 >nul
cd /d "%~dp0"
echo === xpanel: build and install ===
where cargo >nul 2>&1 || (echo Rust not found. Install it from https://rustup.rs & pause & exit /b 1)
where npm >nul 2>&1 || (echo Node.js not found. Install it from https://nodejs.org & pause & exit /b 1)
call npm install --no-audit --no-fund || (pause & exit /b 1)
rem tauri build builds the UI (web/) first, see beforeBuildCommand in src-tauri\tauri.conf.json
call npx tauri build --no-bundle
if errorlevel 1 (
  echo.
  echo Build failed. If the error mentions link.exe, install Visual Studio Build Tools with "Desktop development with C++".
  echo For anything else, send the error above to Claude.
  pause & exit /b 1
)
cargo build --release -p xp-cli
if errorlevel 1 (pause & exit /b 1)
set "DEST=%LOCALAPPDATA%\Programs\xpanel"
if not exist "%DEST%" mkdir "%DEST%"
taskkill /im xpanel.exe /f >nul 2>&1
rem Also close the old program so it stops writing the old workbench.json
taskkill /im workbench.exe /f >nul 2>&1
copy /y "target\release\xpanel.exe" "%DEST%\xpanel.exe" >nul
copy /y "target\release\xp.exe" "%DEST%\xp.exe" >nul
rem Add the install folder to the user PATH once, so xp works in any new terminal
powershell -NoProfile -Command "$d=$env:DEST; $p=[Environment]::GetEnvironmentVariable('Path','User'); if(-not $p){$p=''}; if(($p -split ';') -notcontains $d){[Environment]::SetEnvironmentVariable('Path', (($p.TrimEnd(';') + ';' + $d).TrimStart(';')), 'User'); Write-Host ('Added ' + $d + ' to PATH; new terminals can run xp')}"
if not exist dist mkdir dist
copy /y "target\release\xpanel.exe" "dist\xpanel.exe" >nul
copy /y "target\release\xp.exe" "dist\xp.exe" >nul
echo.
echo Installed to %DEST%
echo The first start puts an xpanel shortcut on the desktop.
echo Settings carry over from the old version; workbench.json in the data folder is imported and renamed to workbench.v1.json.
echo To use it on another PC, copy xpanel.exe (and xp.exe) from the dist folder.
start "" "%DEST%\xpanel.exe"
pause
