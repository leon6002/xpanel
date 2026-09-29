@echo off
rem Fast build for development: builds the UI and both programs, replaces the installed copies, restarts xpanel.
rem Keep this file ASCII only: cmd misreads UTF-8 batch files with Chinese text after chcp.
chcp 65001 >nul
cd /d "%~dp0"
echo === xpanel: fast build and replace (development) ===
echo The first build compiles every dependency and takes a few minutes; later builds take seconds.
echo Use build-windows.bat for a release build.
echo.
where cargo >nul 2>&1 || (echo Rust not found. Install it from https://rustup.rs & pause & exit /b 1)
where npm >nul 2>&1 || (echo Node.js not found. Install it from https://nodejs.org & pause & exit /b 1)
rem UI (web/): install packages (quick when nothing changed), then build web\dist, which is compiled into the programs
call npm --prefix web install --no-audit --no-fund
if errorlevel 1 goto fail
call npm --prefix web run build
if errorlevel 1 goto fail
cargo build --profile fast -p xpanel --features tauri/custom-protocol
if errorlevel 1 goto fail
cargo build --profile fast -p xp-cli
if errorlevel 1 goto fail
set "DEST=%LOCALAPPDATA%\Programs\xpanel"
if not exist "%DEST%" mkdir "%DEST%"
taskkill /im xpanel.exe /f >nul 2>&1
rem The process that was just closed may still hold the file for a moment
timeout /t 1 /nobreak >nul
copy /y "target\fast\xpanel.exe" "%DEST%\xpanel.exe" >nul
if errorlevel 1 (echo Could not replace xpanel.exe - it may still be running. Close it and run dev.bat again. & pause & exit /b 1)
copy /y "target\fast\xp.exe" "%DEST%\xp.exe" >nul
if errorlevel 1 echo Note: xp.exe is in use (probably an AI tool running the xpanel MCP server), so it was not replaced. Close it and run dev.bat again.
echo.
echo Replaced the programs in %DEST%, starting xpanel...
start "" "%DEST%\xpanel.exe"
exit /b 0

:fail
echo.
echo Build failed. Send the error above to Claude.
pause
exit /b 1
