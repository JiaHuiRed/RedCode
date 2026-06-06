@echo off
call "%~dp0..\..\script\sync-home.bat"
if %errorlevel% neq 0 (
    pause
    exit /b %errorlevel%
)
cd /d "%~dp0"

rem 260606 Red 清 vite dep 缓存，避免 workspace 源码更新后 build 仍用旧的 pre-bundle
if exist "node_modules\.vite" rmdir /s /q "node_modules\.vite"

call bun run build 2>&1
if %errorlevel% neq 0 (
    pause
    exit /b %errorlevel%
)
call bun run package 2>&1
if %errorlevel% neq 0 (
    pause
    exit /b %errorlevel%
)
echo Done.
pause
