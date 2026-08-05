# Switch vision-mcp-server between minicpm-v4.6:f16 (fast) and minicpm-v4.5:q5_K_M (detailed)
param([switch]$v45)

# 260805 原先写死 D:\AI\KLX\RedCode\.opencode\redcode.home.jsonc —— 该路径只在某一台机器上
# 存在，换台机器直接报错（与 9b4db72 的探针硬编码同一类地雷）。改成相对脚本自身定位仓库根。
$configFile = Join-Path (Split-Path $PSScriptRoot -Parent) "seed\redcode.home.jsonc"
$content = [System.IO.File]::ReadAllText($configFile, [System.Text.UTF8Encoding]::new($false))

$currentMatch = [regex]::Match($content, 'VISION_MODEL":\s*"([^"]+)"')
if (-not $currentMatch.Success) { Write-Error "Cannot find VISION_MODEL in config"; exit 1 }
$current = $currentMatch.Groups[1].Value

if ($v45 -or $current -eq "minicpm-v4.6:f16") {
  $newModel = "minicpm-v4.5:q5_K_M"
} else {
  $newModel = "minicpm-v4.6:f16"
}

$content = $content -replace 'VISION_MODEL":\s*"[^"]*"', ('VISION_MODEL": "' + $newModel + '"')

[System.IO.File]::WriteAllText($configFile, $content, [System.Text.UTF8Encoding]::new($false))

# Kill running vision-mcp-server so RedCode auto-restarts
Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match "vision-mcp-server" } | Stop-Process -Force

Write-Host "Switched vision MCP to $newModel"
Write-Host "Killed old process. RedCode will restart automatically."
