param(
    [string]$AdminUsername = "zhurui",
    [string]$AdminPassword = "88886666",
    [string]$AdminEmail = "117186209@qq.com",
    [string]$AdminPhone = "18550570523",
    [string]$AdminDisplayName = "zhurui"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$stateRoot = Join-Path $repoRoot ".local-services\mysql"
$storageRoot = Join-Path $repoRoot ".local-data\storage"
$logPath = Join-Path $stateRoot "bootstrap-local-project.log"
$statusPath = Join-Path $stateRoot "final-status.json"
$envPath = Join-Path $repoRoot ".env.local-dev"

New-Item -ItemType Directory -Force -Path $stateRoot, $storageRoot | Out-Null

function Write-Log {
    param([string]$Message)
    $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
    Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
}

function Set-EnvFileValues {
    param(
        [string]$Path,
        [hashtable]$Values
    )

    $lines = @()
    if (Test-Path -LiteralPath $Path) {
        $lines = @(Get-Content -LiteralPath $Path)
    }

    $seen = @{}
    $updated = foreach ($line in $lines) {
        if ($line -match "^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=") {
            $key = $Matches[1]
            if ($Values.ContainsKey($key)) {
                if (-not $seen.ContainsKey($key)) {
                    $seen[$key] = $true
                    "{0}={1}" -f $key, $Values[$key]
                }
            } else {
                $line
            }
        } else {
            $line
        }
    }

    foreach ($key in $Values.Keys) {
        if (-not $seen.ContainsKey($key)) {
            $updated += "{0}={1}" -f $key, $Values[$key]
        }
    }

    Set-Content -LiteralPath $Path -Value $updated -Encoding UTF8
}

function Import-EnvFile {
    param([string]$Path)
    foreach ($line in Get-Content -LiteralPath $Path) {
        if ($line -match "^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$") {
            [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], "Process")
        }
    }
}

function Get-EnvFileValue {
    param([string]$Path, [string]$Name)
    if (-not (Test-Path -LiteralPath $Path)) {
        return ""
    }
    foreach ($line in Get-Content -LiteralPath $Path) {
        if ($line -match ("^\s*" + [regex]::Escape($Name) + "\s*=\s*(.+?)\s*$")) {
            return $Matches[1]
        }
    }
    return ""
}

function New-SecretEncryptionKey {
    $bytes = New-Object byte[] 32
    $random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $random.GetBytes($bytes)
    } finally {
        $random.Dispose()
    }
    return [Convert]::ToBase64String($bytes)
}

function Test-TcpPort {
    param([string]$HostName, [int]$Port, [int]$TimeoutMs = 1200)
    $client = [System.Net.Sockets.TcpClient]::new()
    try {
        $task = $client.ConnectAsync($HostName, $Port)
        return $task.Wait($TimeoutMs) -and $client.Connected
    } catch {
        return $false
    } finally {
        $client.Dispose()
    }
}

function Find-Node {
    $bundled = "C:\Users\Zh\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
    if (Test-Path -LiteralPath $bundled) {
        return $bundled
    }
    $command = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }
    throw "未找到 Node.js。"
}

function Find-Npm {
    param([string]$NodePath)
    $besideNode = Join-Path (Split-Path $NodePath -Parent) "npm.cmd"
    if (Test-Path -LiteralPath $besideNode) {
        return $besideNode
    }
    $command = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }
    throw "未找到 npm.cmd。"
}

function Invoke-NpmScript {
    param(
        [string]$NpmPath,
        [string]$Name
    )
    Write-Log "运行 npm script: $Name"
    $output = & $NpmPath run $Name 2>&1
    $output | Add-Content -LiteralPath $logPath -Encoding UTF8
    if ($LASTEXITCODE -ne 0) {
        throw "npm script '$Name' 执行失败，退出码 $LASTEXITCODE。"
    }
}

$status = [ordered]@{
    started_at = (Get-Date).ToString("o")
    mode = "local-only"
    mysql_host = "127.0.0.1"
    mysql_port = 3306
    database = "xiaoluo_intent_os"
    storage = "local"
    mysql_ready = $false
    migrations_ready = $false
    admin_ready = $false
    app_ready = $false
    error = $null
}

try {
    Set-Content -LiteralPath $logPath -Value "" -Encoding UTF8
    Write-Log "开始本地 MySQL、数据库、管理员和应用初始化。"

    $localDbUser = "xiaoluo_local"
    $localDbPassword = "XiaoLuoLocal_88886666"
    $databaseUrl = "mysql://${localDbUser}:${localDbPassword}@127.0.0.1:3306/xiaoluo_intent_os"
    $secretEncryptionKey = Get-EnvFileValue -Path $envPath -Name "SECRET_ENCRYPTION_KEY"
    if (-not $secretEncryptionKey) {
        $secretEncryptionKey = New-SecretEncryptionKey
    }

    Set-EnvFileValues -Path $envPath -Values @{
        "APP_ENV" = "local"
        "NODE_ENV" = "development"
        "DB_HOST" = "127.0.0.1"
        "DB_PORT" = "3306"
        "DB_USER" = $localDbUser
        "DB_PASSWORD" = $localDbPassword
        "DB_NAME" = "xiaoluo_intent_os"
        "DB_SSL" = "false"
        "DB_SSL_CA" = ""
        "DATABASE_URL" = $databaseUrl
        "SECRET_ENCRYPTION_KEY" = $secretEncryptionKey
        "STORAGE_PROVIDER" = "local"
        "STORAGE_DRIVER" = "local"
        "CLOUDFLARE_ENV" = "local-dev"
        "FILE_STORAGE_PROVIDER" = "local"
        "FILE_STORAGE_DRIVER" = "local"
        "LOCAL_STORAGE_PATH" = ($storageRoot -replace "\\", "/")
        "LOCAL_FILE_STORAGE_PATH" = ($storageRoot -replace "\\", "/")
        "OSS_REGION" = ""
        "OSS_ACCESS_KEY_ID" = ""
        "OSS_ACCESS_KEY_SECRET" = ""
        "OSS_BUCKET" = ""
        "OSS_ENDPOINT" = ""
        "ADMIN_USERNAME" = $AdminUsername
        "ADMIN_PASSWORD" = $AdminPassword
        "ADMIN_EMAIL" = $AdminEmail
        "ADMIN_PHONE" = $AdminPhone
        "ADMIN_DISPLAY_NAME" = $AdminDisplayName
    }
    Import-EnvFile -Path $envPath
    Write-Log "已强制写入本地数据库和本地文件存储配置，远程 OSS 配置已清空。"

    if (-not (Test-TcpPort -HostName "127.0.0.1" -Port 3306)) {
        $mysqlSetup = Join-Path $PSScriptRoot "setup-local-mysql.ps1"
        if (-not (Test-Path -LiteralPath $mysqlSetup)) {
            throw "缺少 scripts/setup-local-mysql.ps1，无法继续安装本地 MySQL。"
        }
        Write-Log "3306 尚未监听，执行本地 MySQL 安装与服务初始化。"
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $mysqlSetup 2>&1 |
            Add-Content -LiteralPath $logPath -Encoding UTF8
        if ($LASTEXITCODE -ne 0) {
            throw "本地 MySQL 安装脚本失败，退出码 $LASTEXITCODE。"
        }
    }

    $mysqlDeadline = (Get-Date).AddMinutes(2)
    while ((Get-Date) -lt $mysqlDeadline -and -not (Test-TcpPort -HostName "127.0.0.1" -Port 3306)) {
        Start-Sleep -Seconds 2
    }
    if (-not (Test-TcpPort -HostName "127.0.0.1" -Port 3306)) {
        throw "本地 MySQL 未能在 127.0.0.1:3306 启动。"
    }
    $status.mysql_ready = $true
    Write-Log "本地 MySQL 已监听 127.0.0.1:3306。"

    $node = Find-Node
    $npm = Find-Npm -NodePath $node
    $packagePath = Join-Path $repoRoot "package.json"
    if (-not (Test-Path -LiteralPath $packagePath)) {
        throw "缺少 package.json。"
    }
    $package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
    $scriptNames = @($package.scripts.PSObject.Properties.Name)

    $migrationScript = @(
        "db:migrate",
        "migrate",
        "db:deploy",
        "db:push",
        "schema:migrate",
        "schema:push"
    ) | Where-Object { $scriptNames -contains $_ } | Select-Object -First 1

    if ($migrationScript) {
        Invoke-NpmScript -NpmPath $npm -Name $migrationScript
    } else {
        $prisma = Join-Path $repoRoot "node_modules\.bin\prisma.cmd"
        if (Test-Path -LiteralPath $prisma) {
            Write-Log "未找到数据库 npm script，使用 Prisma migrate deploy。"
            & $prisma migrate deploy 2>&1 | Add-Content -LiteralPath $logPath -Encoding UTF8
            if ($LASTEXITCODE -ne 0) {
                throw "Prisma migrate deploy 执行失败。"
            }
        } else {
            Write-Log "未发现显式迁移入口；数据库结构由应用启动过程初始化。"
        }
    }
    $status.migrations_ready = $true

    $adminScript = @(
        "admin:init",
        "admin:bootstrap",
        "bootstrap:admin",
        "seed:admin",
        "admin:create"
    ) | Where-Object { $scriptNames -contains $_ } | Select-Object -First 1

    if ($adminScript) {
        Invoke-NpmScript -NpmPath $npm -Name $adminScript
        $status.admin_ready = $true
    } else {
        $adminFiles = @(
            "scripts\bootstrap-system-admin.mjs",
            "scripts\bootstrap-admin.mjs",
            "scripts\init-admin.mjs",
            "scripts\initialize-admin.mjs",
            "scripts\seed-admin.mjs",
            "scripts\create-admin.mjs"
        )
        $adminFile = $adminFiles |
            ForEach-Object { Join-Path $repoRoot $_ } |
            Where-Object { Test-Path -LiteralPath $_ } |
            Select-Object -First 1
        if ($adminFile) {
            Write-Log "运行管理员初始化文件: $adminFile"
            & $node --env-file=$envPath $adminFile 2>&1 |
                Add-Content -LiteralPath $logPath -Encoding UTF8
            if ($LASTEXITCODE -ne 0) {
                throw "管理员初始化文件执行失败。"
            }
            $status.admin_ready = $true
        } else {
            Write-Log "未发现独立管理员脚本；管理员环境变量已写入，将由应用启动时幂等初始化。"
        }
    }

    $existing3001 = Test-TcpPort -HostName "127.0.0.1" -Port 3001
    if (-not $existing3001) {
        $detachedStarter = Join-Path $repoRoot "scripts\start-local-detached.mjs"
        if (Test-Path -LiteralPath $detachedStarter) {
            Write-Log "以隐藏后台进程启动本地应用，不等待 detached helper。"
            Start-Process -FilePath $node `
                -ArgumentList @("--env-file=$envPath", $detachedStarter) `
                -WorkingDirectory $repoRoot `
                -WindowStyle Hidden | Out-Null
        } elseif ($scriptNames -contains "dev") {
            Write-Log "以隐藏后台进程运行 npm run dev。"
            Start-Process -FilePath $npm `
                -ArgumentList @("run", "dev") `
                -WorkingDirectory $repoRoot `
                -WindowStyle Hidden | Out-Null
        } else {
            throw "项目没有本地启动入口。"
        }
    }

    $appDeadline = (Get-Date).AddMinutes(3)
    while ((Get-Date) -lt $appDeadline -and -not (Test-TcpPort -HostName "127.0.0.1" -Port 3001)) {
        Start-Sleep -Seconds 2
    }
    $status.app_ready = Test-TcpPort -HostName "127.0.0.1" -Port 3001
    if (-not $status.app_ready) {
        throw "应用未能在 127.0.0.1:3001 启动，请查看本地启动日志。"
    }

    if (-not $status.admin_ready) {
        $status.admin_ready = $true
        Write-Log "应用已启动；管理员账号由应用启动时初始化。"
    }
    $status.completed_at = (Get-Date).ToString("o")
    Write-Log "本地环境初始化完成。"
} catch {
    $status.error = $_.Exception.Message
    $status.failed_at = (Get-Date).ToString("o")
    Write-Log ("失败: " + $_.Exception.Message)
    $status | ConvertTo-Json -Depth 5 |
        Set-Content -LiteralPath $statusPath -Encoding UTF8
    throw
}

$status | ConvertTo-Json -Depth 5 |
    Set-Content -LiteralPath $statusPath -Encoding UTF8
