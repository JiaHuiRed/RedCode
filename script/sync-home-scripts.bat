@echo off
rem Mirror seed\scripts -> %USERPROFILE%\.redcode\scripts, and nothing else.
rem
rem Same mirror step as script\sync-home.bat, split out so a plain "git pull" can
rem restore these without a full build: sync-home.bat is only ever called from
rem packages\opencode\build.bat and packages\desktop\build-and-package.bat, and it
rem also runs the version check and the config merger - too much for "put my scripts back".
rem
rem 260901 seed became the single source of truth for these scripts and the private
rem repo stopped tracking them, so pulling DELETES the home copies and only this
rem mirror puts them back. On a machine that never builds they just stay gone -
rem which silently breaks /recall (command\recall.md runs scripts\recall-memory.mjs).
rem
rem ASCII-only on purpose: cmd.exe reads .bat in the OEM codepage, UTF-8 comments
rem would corrupt parsing (same reason as sync-home.bat).
cd /d "%~dp0.."
if not exist "seed\scripts" (
  echo [sync-scripts] seed\scripts missing - nothing to mirror
  exit /b 0
)
echo [sync-scripts] seed\scripts to %USERPROFILE%\.redcode\scripts
rem true mirror: wipe first so deleted-in-repo scripts do not linger in home
if exist "%USERPROFILE%\.redcode\scripts" rd /s /q "%USERPROFILE%\.redcode\scripts" >nul 2>&1
xcopy /y /e /i "seed\scripts" "%USERPROFILE%\.redcode\scripts" >nul
if errorlevel 1 (
  echo [sync-scripts] xcopy FAILED
  exit /b 1
)
echo [sync-scripts] done
exit /b 0
