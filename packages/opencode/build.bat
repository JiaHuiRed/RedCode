@echo off
call "%~dp0..\..\script\sync-home.bat"
if %errorlevel% neq 0 (
    pause
    exit /b %errorlevel%
)
cd /d "%~dp0"
call bun run build -- --single 2>&1
if %errorlevel% neq 0 (
    pause
    exit /b %errorlevel%
)
echo Done.
pause
