@echo off
call "%~dp0..\..\script\sync-home.bat"
if %errorlevel% neq 0 (
    pause
    exit /b %errorlevel%
)
cd /d "%~dp0"
REM Default: skip Web UI rebuild (already embedded in last full build).
REM Pass "full" as argument to re-embed Web UI: build.bat full
if /i "%~1"=="full" (
    call bun run build 2>&1
) else (
    call bun run build -- --skip-embed-web-ui 2>&1
)
if %errorlevel% neq 0 (
    pause
    exit /b %errorlevel%
)
echo Done.
pause
