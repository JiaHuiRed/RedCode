@echo off
rem Shared home sync: called by packages/opencode/build.bat and packages/desktop/build-and-package.bat
rem Single source of truth, prevents drift between the two bats (souls/hub/skill must all sync)
rem ASCII-only on purpose: cmd.exe reads .bat in the OEM codepage, UTF-8 comments would corrupt parsing
cd /d "%~dp0.."
call bun run script/check-version-consistency.ts
if %errorlevel% neq 0 exit /b %errorlevel%
echo [sync] souls/memory/agents/config/skills to %USERPROFILE%\.redcode
if not exist ".opencode\agents\Gsoul.md" goto :done
if not exist "%USERPROFILE%\.redcode" mkdir "%USERPROFILE%\.redcode" >nul 2>&1
if not exist "%USERPROFILE%\.redcode\souls" mkdir "%USERPROFILE%\.redcode\souls" >nul 2>&1
copy /y ".opencode\agents\Gsoul.md" "%USERPROFILE%\.redcode\souls\Gsoul.md" >nul
copy /y ".opencode\agents\Tsoul.md" "%USERPROFILE%\.redcode\souls\Tsoul.md" >nul
copy /y ".opencode\MEMORY.md" "%USERPROFILE%\.redcode\MEMORY.md" >nul
copy /y "AGENTS.md" "%USERPROFILE%\.redcode\AGENTS.md" >nul
rem hub injector: rebuild ~/.redcode/redcode.jsonc (instructions injection chain)
if exist ".opencode\redcode.home.jsonc" copy /y ".opencode\redcode.home.jsonc" "%USERPROFILE%\.redcode\redcode.jsonc" >nul
rem global skill: repo staging -> ~/.redcode/skill (engine home scan, loaded by every project)
if exist ".opencode\skill" xcopy /y /e /i ".opencode\skill" "%USERPROFILE%\.redcode\skill" >nul
echo [sync] done
:done
exit /b 0
