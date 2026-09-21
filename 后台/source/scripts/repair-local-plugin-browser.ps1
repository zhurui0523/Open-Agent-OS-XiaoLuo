param(
  [string]$PackageName = "xiaoluo-panorama"
)

$ErrorActionPreference = "Stop"

$workspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$artifactRoot = Join-Path $workspaceRoot ".local-data\storage\package-artifacts"
$statusFile = Join-Path $workspaceRoot ".tmp-plugin-browser-repair.json"
$workRoot = Join-Path $workspaceRoot ".tmp-plugin-browser-repair"

function Write-RepairStatus {
  param(
    [string]$Status,
    [string]$Message,
    [hashtable]$Extra = @{}
  )

  $payload = @{
    status = $Status
    message = $Message
    updatedAt = (Get-Date).ToString("o")
  }

  foreach ($key in $Extra.Keys) {
    $payload[$key] = $Extra[$key]
  }

  $payload | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $statusFile -Encoding UTF8
}

try {
  if (-not (Test-Path -LiteralPath $artifactRoot)) {
    throw "本地插件制品目录不存在：$artifactRoot"
  }

  $artifact = Get-ChildItem -LiteralPath $artifactRoot -Recurse -File -Filter *.xlpkg |
    Where-Object { $_.FullName -like "*$PackageName*" } |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1

  if (-not $artifact) {
    throw "没有找到匹配 $PackageName 的本地插件制品"
  }

  if (Test-Path -LiteralPath $workRoot) {
    $resolvedWorkRoot = [System.IO.Path]::GetFullPath($workRoot)
    $resolvedWorkspaceRoot = [System.IO.Path]::GetFullPath($workspaceRoot)
    if (-not $resolvedWorkRoot.StartsWith($resolvedWorkspaceRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "拒绝清理工作区以外的临时目录"
    }
    Remove-Item -LiteralPath $resolvedWorkRoot -Recurse -Force
  }

  New-Item -ItemType Directory -Path $workRoot | Out-Null
  $archiveCopy = Join-Path $workRoot "plugin.zip"
  $extractRoot = Join-Path $workRoot "extract"
  Copy-Item -LiteralPath $artifact.FullName -Destination $archiveCopy
  Expand-Archive -LiteralPath $archiveCopy -DestinationPath $extractRoot -Force

  $packageJson = Get-ChildItem -LiteralPath $extractRoot -Recurse -File -Filter package.json |
    Where-Object {
      $_.FullName -notlike "*\node_modules\*" -and
      $_.FullName -notlike "*\dist\*" -and
      $_.FullName -notlike "*\build\*"
    } |
    Sort-Object { $_.FullName.Length } |
    Select-Object -First 1

  if (-not $packageJson) {
    throw "插件仓库中没有找到 package.json，无法构建浏览器界面"
  }

  $projectRoot = $packageJson.Directory.FullName
  $distIndex = Join-Path $projectRoot "dist\index.html"

  if (-not (Test-Path -LiteralPath $distIndex)) {
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npm) {
      throw "没有找到 npm.cmd，无法构建插件浏览器界面"
    }

    $installLog = Join-Path $workRoot "npm-install.log"
    $buildLog = Join-Path $workRoot "npm-build.log"

    & $npm.Source install --ignore-scripts --no-audit --no-fund *> $installLog
    if ($LASTEXITCODE -ne 0) {
      throw "插件依赖安装失败，详情见 $installLog"
    }

    & $npm.Source run build *> $buildLog
    if ($LASTEXITCODE -ne 0) {
      throw "插件构建失败，详情见 $buildLog"
    }
  }

  if (-not (Test-Path -LiteralPath $distIndex)) {
    throw "构建完成后仍未生成 dist/index.html"
  }

  Get-ChildItem -LiteralPath (Join-Path $projectRoot "dist") -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $projectRoot -Recurse -Force
  }

  $backup = "$($artifact.FullName).source-backup"
  if (-not (Test-Path -LiteralPath $backup)) {
    Copy-Item -LiteralPath $artifact.FullName -Destination $backup
  }

  $rebuiltZip = Join-Path $workRoot "rebuilt.zip"
  $topLevelEntries = Get-ChildItem -LiteralPath $extractRoot -Force
  Compress-Archive -LiteralPath $topLevelEntries.FullName -DestinationPath $rebuiltZip -CompressionLevel Optimal -Force
  Copy-Item -LiteralPath $rebuiltZip -Destination $artifact.FullName -Force

  Write-RepairStatus -Status "ok" -Message "插件浏览器静态产物已构建并写回本地制品" -Extra @{
    artifact = $artifact.FullName
    projectRoot = $projectRoot
    backup = $backup
  }
}
catch {
  Write-RepairStatus -Status "error" -Message $_.Exception.Message
  exit 1
}
