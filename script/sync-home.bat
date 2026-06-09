@echo off
rem Shared home sync: called by packages/opencode/build.bat and packages/desktop/build-and-package.bat
rem Now only syncs community/shared files. Personal files (souls/memory/MEMORY.md) live in ~/.redcode/
rem and come from the user's private redcode-private repo.
rem ASCII-only on purpose: cmd.exe reads .bat in the OEM codepage, UTF-8 comments would corrupt parsing
cd /d "%~dp0.."
call bun run script/check-version-consistency.ts
if %errorlevel% neq 0 exit /b %errorlevel%
if not exist "%USERPROFILE%\.redcode" mkdir "%USERPROFILE%\.redcode" >nul 2>&1
echo [sync] shared config/skills to %USERPROFILE%\.redcode

rem hub injector: rebuild ~/.redcode/redcode.jsonc (instructions injection chain)
if exist ".opencode\redcode.home.jsonc" copy /y ".opencode\redcode.home.jsonc" "%USERPROFILE%\.redcode\redcode.jsonc" >nul

rem global skill: repo staging -> ~/.redcode/skill (engine home scan, loaded by every project)
rem true mirror: wipe first so deleted-in-repo copies do not linger in home
if exist "%USERPROFILE%\.redcode\skill" rd /s /q "%USERPROFILE%\.redcode\skill" >nul 2>&1
if exist ".opencode\skill" xcopy /y /e /i ".opencode\skill" "%USERPROFILE%\.redcode\skill" >nul

rem global commands: repo staging -> ~/.redcode/command (engine scans .redcode only)
rem NOTE: Only shared commands are in this repo. Personal commands (tui-persona.md, gui-persona.md)
rem live in ~/.redcode/command/ from the user's private repo and are NOT overwritten.
if not exist "%USERPROFILE%\.redcode\command" mkdir "%USERPROFILE%\.redcode\command" >nul 2>&1
if exist ".opencode\command" xcopy /y /e /i ".opencode\command" "%USERPROFILE%\.redcode\command" >nul

rem global scripts: repo staging -> ~/.redcode/scripts (called by slash commands, e.g. /recall)
rem true mirror: wipe first so deleted-in-repo scripts do not linger in home
if exist "%USERPROFILE%\.redcode\scripts" rd /s /q "%USERPROFILE%\.redcode\scripts" >nul 2>&1
if exist ".opencode\scripts" xcopy /y /e /i ".opencode\scripts" "%USERPROFILE%\.redcode\scripts" >nul

rem global plugin: only memory.ts (CORE per-turn injector). Engine scans ~/.redcode/plugin for every project.
rem Selective copy on purpose: do NOT mirror the whole .opencode\plugins (smoke/stub files stay repo-local).
if not exist "%USERPROFILE%\.redcode\plugin" mkdir "%USERPROFILE%\.redcode\plugin" >nul 2>&1
if exist ".opencode\plugins\memory.ts" copy /y ".opencode\plugins\memory.ts" "%USERPROFILE%\.redcode\plugin\memory.ts" >nul

echo [sync] done
exit /b 0
