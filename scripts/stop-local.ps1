[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$runtimeDir = Join-Path $projectRoot ".local-data\runtime"
$pidFile = Join-Path $runtimeDir "app.pid"
$portFile = Join-Path $runtimeDir "app.port"
$statusFile = Join-Path $runtimeDir "app.status.json"

if (-not (Test-Path -LiteralPath $pidFile)) {
  Write-Host "XiaoLuo 本地服务没有已登记的运行进程。"
  exit 0
}

$appProcessIdText = (Get-Content -LiteralPath $pidFile -Raw).Trim()
$appProcessId = 0
if (-not [int]::TryParse($appProcessIdText, [ref]$appProcessId)) {
  throw "PID 文件无效：$pidFile"
}

$process = Get-CimInstance Win32_Process -Filter "ProcessId = $appProcessId" -ErrorAction SilentlyContinue
if ($null -eq $process) {
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $portFile -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $statusFile -Force -ErrorAction SilentlyContinue
  Write-Host "登记的进程已经结束，已清理陈旧状态。"
  exit 0
}

$normalizedRoot = $projectRoot.Replace("\", "/")
$normalizedCommandLine = ([string]$process.CommandLine).Replace("\", "/")
if (-not $normalizedCommandLine.Contains($normalizedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "拒绝停止 PID $appProcessId：它不属于当前项目。"
}

Stop-Process -Id $appProcessId -Force
Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $portFile -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $statusFile -Force -ErrorAction SilentlyContinue
Write-Host "XiaoLuo 本地服务已停止。"
