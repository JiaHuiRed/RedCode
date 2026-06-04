@echo off
cd /d "%~dp0..\.."
call bun run script/check-version-consistency.ts
if %errorlevel% neq 0 (
    pause
    exit /b %errorlevel%
)
echo [sync] souls/memory/agents to %USERPROFILE%\.redcode
if not exist ".opencode\agents\Gsoul.md" goto :skip_souls
if not exist "%USERPROFILE%\.redcode\souls" mkdir "%USERPROFILE%\.redcode\souls" >nul 2>&1
copy /y ".opencode\agents\Gsoul.md" "%USERPROFILE%\.redcode\souls\Gsoul.md" >nul
copy /y ".opencode\agents\Tsoul.md" "%USERPROFILE%\.redcode\souls\Tsoul.md" >nul
copy /y ".opencode\MEMORY.md" "%USERPROFILE%\.redcode\MEMORY.md" >nul
copy /y "AGENTS.md" "%USERPROFILE%\.redcode\AGENTS.md" >nul
echo [sync] done
:skip_souls
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
