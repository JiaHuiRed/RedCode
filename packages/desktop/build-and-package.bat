@echo off
call "%~dp0..\..\script\sync-home.bat"
if %errorlevel% neq 0 (
    pause
    exit /b %errorlevel%
)
cd /d "%~dp0"
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
