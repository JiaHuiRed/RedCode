@echo off
rem Shared home sync: called by packages/opencode/build.bat and packages/desktop/build-and-package.bat
rem Now only syncs community/shared files. Personal files (souls/memory/MEMORY.md) live in ~/.redcode/
rem and come from the user's private redcode-private repo.
rem 260805 source dir renamed .opencode -> seed: it was never loaded as project config
rem (the engine only scans .redcode), it is staging/seed material - the name now says so.
rem ASCII-only on purpose: cmd.exe reads .bat in the OEM codepage, UTF-8 comments would corrupt parsing
cd /d "%~dp0.."
call bun run script/check-version-consistency.ts
if %errorlevel% neq 0 exit /b %errorlevel%
if not exist "%USERPROFILE%\.redcode" mkdir "%USERPROFILE%\.redcode" >nul 2>&1
echo [sync] shared config/skills to %USERPROFILE%\.redcode

rem hub injector: merge template into ~/.redcode/redcode.jsonc (user keys preserved, new template keys added)
call bun run script/merge-home-config.ts

rem global skill: home/.redcode/skill is the WORKING SOURCE OF TRUTH (personas write skills there,
rem tracked by the private repo). Repo staging only SEEDS skills MISSING in home - never wipe,
rem never overwrite - so local/private edits are never clobbered by an older repo copy on rebuild.
if not exist "%USERPROFILE%\.redcode\skill" mkdir "%USERPROFILE%\.redcode\skill" >nul 2>&1
if exist "seed\skill" for /d %%S in (seed\skill\*) do if not exist "%USERPROFILE%\.redcode\skill\%%~nxS" xcopy /e /i /q /y "%%S" "%USERPROFILE%\.redcode\skill\%%~nxS\" >nul

rem global commands: repo staging -> ~/.redcode/command (engine scans .redcode only)
rem Seed-only: copy each file only if it does NOT already exist in home.
rem Private-repo edits (persona commands etc.) are never overwritten.
if not exist "%USERPROFILE%\.redcode\command" mkdir "%USERPROFILE%\.redcode\command" >nul 2>&1
if exist "seed\command" for %%F in (seed\command\*) do if not exist "%USERPROFILE%\.redcode\command\%%~nxF" copy /y "%%F" "%USERPROFILE%\.redcode\command\%%~nxF" >nul

rem global agents: repo staging -> ~/.redcode/agent (engine scans {agent,agents} under .redcode dirs)
rem 260805 added: architect/fixer/reviewer had been sitting in the staging dir since 1b6c1e3 with
rem nothing loading them - `agent list` never showed them. Seeding them here is what makes them real.
if not exist "%USERPROFILE%\.redcode\agent" mkdir "%USERPROFILE%\.redcode\agent" >nul 2>&1
if exist "seed\agents" for %%F in (seed\agents\*.md) do if not exist "%USERPROFILE%\.redcode\agent\%%~nxF" copy /y "%%F" "%USERPROFILE%\.redcode\agent\%%~nxF" >nul

rem global scripts: repo staging -> ~/.redcode/scripts (called by slash commands, e.g. /recall)
rem true mirror: wipe first so deleted-in-repo scripts do not linger in home
if exist "%USERPROFILE%\.redcode\scripts" rd /s /q "%USERPROFILE%\.redcode\scripts" >nul 2>&1
if exist "seed\scripts" xcopy /y /e /i "seed\scripts" "%USERPROFILE%\.redcode\scripts" >nul

rem global plugin: only memory.ts (CORE per-turn injector). Engine scans ~/.redcode/plugin for every project.
rem Selective copy on purpose: do NOT mirror the whole seed\plugins (smoke/stub files stay repo-local).
if not exist "%USERPROFILE%\.redcode\plugin" mkdir "%USERPROFILE%\.redcode\plugin" >nul 2>&1
if exist "seed\plugins\memory.ts" copy /y "seed\plugins\memory.ts" "%USERPROFILE%\.redcode\plugin\memory.ts" >nul

echo [sync] done
exit /b 0
