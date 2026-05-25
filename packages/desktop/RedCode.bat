@echo off
cd /d "%~dp0"
start "" "node_modules\.bun\electron@42.2.0\node_modules\electron\dist\electron.exe" "%~dp0"
