param(
  [string]$MySqlVersion = "8.4.9"
)

$ErrorActionPreference = "Stop"
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$runtimeRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot ".local-runtime"))
$dataRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot ".local-data\mysql"))
$filesRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot ".local-data\mysql-files"))
$mysqlFolder = "mysql-$MySqlVersion-winx64"
$mysqlHome = [System.IO.Path]::GetFullPath((Join-Path $runtimeRoot $mysqlFolder))
$archive = [System.IO.Path]::GetFullPath((Join-Path $runtimeRoot "$mysqlFolder.zip"))
$optionFile = [System.IO.Path]::GetFullPath((Join-Path $runtimeRoot "mysql-local.ini"))
$downloadUrl = "https://cdn.mysql.com/Downloads/MySQL-8.4/$mysqlFolder.zip"
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$nodeExe = if ($nodeCommand) {
  $nodeCommand.Source
} else {
  Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
}
if (-not (Test-Path -LiteralPath $nodeExe)) {
  throw "Node.js 22 or newer is required."
}

foreach ($target in @($runtimeRoot, $dataRoot, $filesRoot, $mysqlHome, $archive, $optionFile)) {
  if (-not $target.StartsWith($projectRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Local runtime path escaped the project workspace: $target"
  }
}

New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
New-Item -ItemType Directory -Force -Path $dataRoot | Out-Null
New-Item -ItemType Directory -Force -Path $filesRoot | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $projectRoot ".local-data\logs") | Out-Null

$mysqld = Join-Path $mysqlHome "bin\mysqld.exe"
if (-not (Test-Path -LiteralPath $mysqld)) {
  if (-not (Test-Path -LiteralPath $archive)) {
    Write-Host "[XiaoLuoAgentOS] Downloading MySQL $MySqlVersion LTS from Oracle..."
    & curl.exe --fail --location --retry 3 --output $archive $downloadUrl
    if ($LASTEXITCODE -ne 0) {
      throw "MySQL download failed. URL: $downloadUrl"
    }
  }
  $archiveInfo = Get-Item -LiteralPath $archive
  if ($archiveInfo.Length -lt 250MB) {
    throw "Downloaded MySQL archive is unexpectedly small."
  }
  Write-Host "[XiaoLuoAgentOS] Extracting local MySQL..."
  Expand-Archive -LiteralPath $archive -DestinationPath $runtimeRoot -Force
}

$slashHome = $mysqlHome.Replace("\", "/")
$slashData = $dataRoot.Replace("\", "/")
$slashFiles = $filesRoot.Replace("\", "/")
$errorLog = ([System.IO.Path]::GetFullPath((Join-Path $projectRoot ".local-data\logs\mysql-error.log"))).Replace("\", "/")
$pidFile = ([System.IO.Path]::GetFullPath((Join-Path $dataRoot "mysql.pid"))).Replace("\", "/")
$configuration = @"
[mysqld]
basedir=$slashHome
datadir=$slashData
port=3307
bind-address=127.0.0.1
mysqlx=0
character-set-server=utf8mb4
collation-server=utf8mb4_unicode_ci
default-time-zone=+00:00
log-error=$errorLog
pid-file=$pidFile
secure-file-priv=$slashFiles

[client]
port=3307
default-character-set=utf8mb4
"@
[System.IO.File]::WriteAllText(
  $optionFile,
  $configuration,
  (New-Object System.Text.UTF8Encoding($false))
)

if (-not (Test-Path -LiteralPath (Join-Path $dataRoot "mysql"))) {
  if (Test-Path -LiteralPath $dataRoot) {
    Remove-Item -LiteralPath $dataRoot -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $dataRoot | Out-Null
  Write-Host "[XiaoLuoAgentOS] Initializing local MySQL data directory..."
  & $mysqld "--defaults-file=$optionFile" --initialize-insecure --console
  if ($LASTEXITCODE -ne 0) {
    throw "MySQL data directory initialization failed."
  }
}

Write-Host "[XiaoLuoAgentOS] Starting local MySQL..."
& $nodeExe --env-file=.env.local-dev scripts/local-mysql.mjs start
if ($LASTEXITCODE -ne 0) {
  throw "MySQL startup failed."
}

$mysql = Join-Path $mysqlHome "bin\mysql.exe"
$sql = @"
CREATE DATABASE IF NOT EXISTS xiaoluo_intent_os CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'xiaoluo_local'@'127.0.0.1' IDENTIFIED BY 'XiaoLuoLocal_88886666';
ALTER USER 'xiaoluo_local'@'127.0.0.1' IDENTIFIED BY 'XiaoLuoLocal_88886666';
CREATE USER IF NOT EXISTS 'xiaoluo_local'@'localhost' IDENTIFIED BY 'XiaoLuoLocal_88886666';
ALTER USER 'xiaoluo_local'@'localhost' IDENTIFIED BY 'XiaoLuoLocal_88886666';
GRANT ALL PRIVILEGES ON xiaoluo_intent_os.* TO 'xiaoluo_local'@'127.0.0.1';
GRANT ALL PRIVILEGES ON xiaoluo_intent_os.* TO 'xiaoluo_local'@'localhost';
ALTER USER 'root'@'localhost' IDENTIFIED BY 'xiaoluo-local-root-development-only';
FLUSH PRIVILEGES;
"@

$rootSecured = $false
$previousMysqlPassword = $env:MYSQL_PWD
$env:MYSQL_PWD = "xiaoluo-local-root-development-only"
& $mysql --connect-timeout=3 --protocol=TCP --host=127.0.0.1 --port=3307 --user=root --execute="SELECT 1" 2>$null
if ($LASTEXITCODE -eq 0) {
  $rootSecured = $true
}

if ($rootSecured) {
  $sql = $sql.Replace(
    "ALTER USER 'root'@'localhost' IDENTIFIED BY 'xiaoluo-local-root-development-only';",
    ""
  )
  & $mysql --connect-timeout=3 --protocol=TCP --host=127.0.0.1 --port=3307 --user=root --execute=$sql
} else {
  Remove-Item Env:MYSQL_PWD -ErrorAction SilentlyContinue
  & $mysql --connect-timeout=3 --protocol=TCP --host=127.0.0.1 --port=3307 --user=root --skip-password --execute=$sql
}
$env:MYSQL_PWD = $previousMysqlPassword
if ($LASTEXITCODE -ne 0) {
  throw "Creating the local database and application user failed."
}

Write-Host "[XiaoLuoAgentOS] Local MySQL is ready on 127.0.0.1:3307."
