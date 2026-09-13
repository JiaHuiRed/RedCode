@echo off
rem 260913 Karina: one-click phone access entry. Starts a headless server on the LAN so a phone
rem on the same Wi-Fi can open the web UI. ASCII-only on purpose: a .bat containing non-ASCII
rem must be GBK or the console mangles it.
rem
rem Why `cd packages\opencode`: the compiled exe resolves the web UI bundle from the current
rem working directory (`redcode-web-ui.gen.ts` -> `../app/dist`). Started from the repo root the
rem root page returns 500 (the in-binary import misses and the cwd fallback finds nothing).
rem Keep the cd.
rem
rem `redcode web` prints the exact Network access URL itself (it enumerates the real interfaces)
rem and applies the LAN password gate, so this script does not try to guess an IP.
setlocal

set "PORT=4097"

rem --- locate the checkout (same probe order as %USERPROFILE%\.redcode\bin\redcode.cmd) ---
set "ROOT="
if defined REDCODE_HOME if exist "%REDCODE_HOME%\packages\opencode\src\index.ts" set "ROOT=%REDCODE_HOME%"
if not defined ROOT if exist "E:\AI\RedCode\packages\opencode\src\index.ts" set "ROOT=E:\AI\RedCode"
if not defined ROOT if exist "D:\AI\RedCode\packages\opencode\src\index.ts" set "ROOT=D:\AI\RedCode"
if not defined ROOT if exist "D:\AI\KLX\RedCode\packages\opencode\src\index.ts" set "ROOT=D:\AI\KLX\RedCode"
if not defined ROOT if exist "C:\AI\RedCode\packages\opencode\src\index.ts" set "ROOT=C:\AI\RedCode"
if not defined ROOT (
  echo [RedCode] cannot locate a checkout. Set REDCODE_HOME to the repo root and retry.
  pause
  exit /b 1
)

set "SHOWPASS=RedCode0429 (built-in default)"
if defined REDCODE_SERVER_PASSWORD set "SHOWPASS=%REDCODE_SERVER_PASSWORD% (from REDCODE_SERVER_PASSWORD)"

rem --- already listening? just tell the user where to go, do not start a second server ---
rem goto instead of a parenthesised block: the password echoed below comes from the env and
rem may contain `)`, which would break a block's parsing.
netstat -ano | findstr /r /c:":%PORT% .*LISTENING" >nul 2>&1
if errorlevel 1 goto start_server

echo ==============================================================
echo   RedCode - phone access (LAN) - already running
echo ==============================================================
echo   Port %PORT% is already listening. On your phone, open:
powershell -NoProfile -Command "Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.|172\.|198\.18\.|198\.19\.)' } | ForEach-Object { '       http://' + $_.IPAddress + ':%PORT%' }"
echo   Username :  redcode
echo   Password :  %SHOWPASS%
echo.
echo   Close the other RedCode window to stop the server.
echo ==============================================================
pause
exit /b 0

:start_server

echo ==============================================================
echo   RedCode - phone access (LAN)
echo ==============================================================
echo   On your phone, open the "Network access" URL printed below.
echo   Username :  redcode
echo   Password :  %SHOWPASS%
echo.
echo   Keep this window open while you use your phone.
echo   Close it (or press Ctrl+C) to stop the server.
echo ==============================================================
echo.

cd /d "%ROOT%\packages\opencode"
if exist "%USERPROFILE%\.redcode\bin\redcode.cmd" (
  call "%USERPROFILE%\.redcode\bin\redcode.cmd" web --hostname 0.0.0.0 --port %PORT%
) else (
  call redcode web --hostname 0.0.0.0 --port %PORT%
)

echo.
echo [RedCode] server stopped.
pause
endlocal
