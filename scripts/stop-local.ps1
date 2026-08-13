[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$runtimeDir = Join-Path $projectRoot ".local-data\runtime"
$pidFile = Join-Path $runtimeDir "app.pid"
$portFile = Join-Path $runtimeDir "app.port"
$statusFile = Join-Path $runtimeDir "app.status.json"

if (-not (Test-Path -LiteralPath $pidFile)) {
  Write-Host "XiaoLuo local service has no registered running process."
  exit 0
}

$appProcessIdText = (Get-Content -LiteralPath $pidFile -Raw).Trim()
$appProcessId = 0
if (-not [int]::TryParse($appProcessIdText, [ref]$appProcessId)) {
  throw "Invalid PID file: $pidFile"
}

$process = Get-CimInstance Win32_Process `
  -Filter "ProcessId = $appProcessId" `
  -ErrorAction SilentlyContinue
if ($null -eq $process) {
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $portFile -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $statusFile -Force -ErrorAction SilentlyContinue
  Write-Host "The recorded local process has already exited; stale state was removed."
  exit 0
}

$normalizedRoot = $projectRoot.Replace("\", "/")
$normalizedCommandLine = ([string]$process.CommandLine).Replace("\", "/")
if (-not $normalizedCommandLine.Contains(
    $normalizedRoot,
    [System.StringComparison]::OrdinalIgnoreCase
  )) {
  throw "Refusing to stop PID $appProcessId because it does not belong to this project."
}

Stop-Process -Id $appProcessId -Force
Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $portFile -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $statusFile -Force -ErrorAction SilentlyContinue
Write-Host "XiaoLuo local service stopped."
