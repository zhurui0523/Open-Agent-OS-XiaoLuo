param(
    [string]$ServiceName = "XiaoLuoMySQL",
    [int]$Port = 3306,
    [string]$DatabaseName = "xiaoluo_intent_os",
    [string]$DatabaseUser = "xiaoluo_local",
    [string]$DatabasePassword = "XiaoLuoLocal_88886666",
    [string]$RootPassword = "XiaoLuoRoot_88886666"
)

$ErrorActionPreference = "Stop"

function Test-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Find-MySqlBinary {
    param([string]$Name)

    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }

    $roots = @(
        (Join-Path $env:ProgramFiles "MySQL"),
        (Join-Path $env:ProgramFiles "MariaDB"),
        (Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages")
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }

    foreach ($root in $roots) {
        $match = Get-ChildItem -LiteralPath $root -Recurse -File -Filter $Name -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($match) {
            return $match.FullName
        }
    }

    return $null
}

function Convert-ToIniPath {
    param([string]$Path)
    return $Path.Replace("\", "/")
}

function Invoke-MySql {
    param(
        [string]$Sql,
        [switch]$AllowPasswordless
    )

    $arguments = @(
        "--protocol=tcp",
        "--host=127.0.0.1",
        "--port=$Port",
        "--user=root",
        "--password=$RootPassword",
        "--connect-timeout=5",
        "--execute=$Sql"
    )

    & $script:MySqlExe @arguments *> $null
    if ($LASTEXITCODE -eq 0) {
        return $true
    }

    if ($AllowPasswordless) {
        $passwordlessArguments = @(
            "--protocol=tcp",
            "--host=127.0.0.1",
            "--port=$Port",
            "--user=root",
            "--connect-timeout=5",
            "--execute=$Sql"
        )
        & $script:MySqlExe @passwordlessArguments *> $null
        return $LASTEXITCODE -eq 0
    }

    return $false
}

if (-not (Test-Administrator)) {
    throw "安装和注册本地 MySQL 服务需要 Windows 管理员权限。"
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$localRoot = Join-Path $repoRoot ".local-services\mysql"
$dataDir = Join-Path $localRoot "data"
$configPath = Join-Path $localRoot "my.ini"
$errorLog = Join-Path $localRoot "mysql-error.log"
$pidFile = Join-Path $localRoot "mysql.pid"

New-Item -ItemType Directory -Path $localRoot -Force | Out-Null
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null

$mysqldExe = Find-MySqlBinary "mysqld.exe"
$script:MySqlExe = Find-MySqlBinary "mysql.exe"

if (-not $mysqldExe -or -not $script:MySqlExe) {
    throw "未找到 MySQL Server 可执行文件，请先安装 Oracle MySQL Server。"
}

$baseDir = Split-Path (Split-Path $mysqldExe -Parent) -Parent
$ini = @"
[mysqld]
basedir=$(Convert-ToIniPath $baseDir)
datadir=$(Convert-ToIniPath $dataDir)
port=$Port
bind-address=127.0.0.1
mysqlx=0
character-set-server=utf8mb4
collation-server=utf8mb4_unicode_ci
max_allowed_packet=64M
log-error=$(Convert-ToIniPath $errorLog)
pid-file=$(Convert-ToIniPath $pidFile)
skip-name-resolve=1

[client]
port=$Port
host=127.0.0.1
default-character-set=utf8mb4
"@

Set-Content -LiteralPath $configPath -Value $ini -Encoding ASCII

$systemTable = Join-Path $dataDir "mysql"
if (-not (Test-Path -LiteralPath $systemTable)) {
    & $mysqldExe "--defaults-file=$configPath" "--initialize-insecure" *> $null
    if ($LASTEXITCODE -ne 0) {
        throw "MySQL 数据目录初始化失败，请查看 $errorLog"
    }
}

$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if (-not $service) {
    & $mysqldExe "--install" $ServiceName "--defaults-file=$configPath" *> $null
    if ($LASTEXITCODE -ne 0) {
        throw "MySQL Windows 服务注册失败。"
    }
}

$service = Get-Service -Name $ServiceName
if ($service.Status -ne "Running") {
    Start-Service -Name $ServiceName
}

$ready = $false
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    if (Test-NetConnection -ComputerName 127.0.0.1 -Port $Port -InformationLevel Quiet -WarningAction SilentlyContinue) {
        $ready = $true
        break
    }
    Start-Sleep -Milliseconds 500
}

if (-not $ready) {
    throw "MySQL 服务已注册但未能在 127.0.0.1:$Port 启动，请查看 $errorLog"
}

if (-not (Invoke-MySql -Sql "SELECT 1;" -AllowPasswordless)) {
    throw "无法使用本地 root 账号连接 MySQL。"
}

$escapedDatabase = $DatabaseName.Replace("``", "````")
$escapedUser = $DatabaseUser.Replace("'", "''")
$escapedDatabasePassword = $DatabasePassword.Replace("'", "''")
$escapedRootPassword = $RootPassword.Replace("'", "''")

$bootstrapSql = @"
CREATE DATABASE IF NOT EXISTS ``$escapedDatabase`` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '$escapedUser'@'127.0.0.1' IDENTIFIED BY '$escapedDatabasePassword';
ALTER USER '$escapedUser'@'127.0.0.1' IDENTIFIED BY '$escapedDatabasePassword';
CREATE USER IF NOT EXISTS '$escapedUser'@'localhost' IDENTIFIED BY '$escapedDatabasePassword';
ALTER USER '$escapedUser'@'localhost' IDENTIFIED BY '$escapedDatabasePassword';
GRANT ALL PRIVILEGES ON ``$escapedDatabase``.* TO '$escapedUser'@'127.0.0.1';
GRANT ALL PRIVILEGES ON ``$escapedDatabase``.* TO '$escapedUser'@'localhost';
FLUSH PRIVILEGES;
"@

if (-not (Invoke-MySql -Sql $bootstrapSql -AllowPasswordless)) {
    throw "创建本地数据库及应用账号失败。"
}

$setRootPasswordSql = "ALTER USER 'root'@'localhost' IDENTIFIED BY '$escapedRootPassword'; FLUSH PRIVILEGES;"
Invoke-MySql -Sql $setRootPasswordSql -AllowPasswordless | Out-Null

$status = @{
    service = $ServiceName
    host = "127.0.0.1"
    port = $Port
    database = $DatabaseName
    user = $DatabaseUser
    dataDir = $dataDir
    configuredAt = (Get-Date).ToString("o")
} | ConvertTo-Json

Set-Content -LiteralPath (Join-Path $localRoot "status.json") -Value $status -Encoding UTF8
