[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoPath = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$stateDir = Join-Path $repoPath ".local-services\mysql\finalize"
$logDir = Join-Path $repoPath ".local-services\mysql"
$envFile = Join-Path $repoPath ".env.local-dev"
$storagePath = Join-Path $repoPath ".local-data\storage"
$serviceName = "XiaoLuoMySQL"

New-Item -ItemType Directory -Force -Path $stateDir, $logDir, $storagePath | Out-Null

Get-ChildItem -LiteralPath $stateDir -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match "^\d\d-" -or $_.Name -eq "FINAL_STATUS.txt" } |
    Remove-Item -Force -ErrorAction SilentlyContinue

function Write-Step {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Value
    )
    Set-Content -LiteralPath (Join-Path $stateDir $Name) -Value $Value -Encoding utf8
}

function Fail-Step {
    param(
        [Parameter(Mandatory = $true)][string]$Step,
        [Parameter(Mandatory = $true)][string]$Message
    )
    Write-Step -Name "$Step.failed" -Value $Message
    Write-Step -Name "FINAL_STATUS.txt" -Value "FAILED:$Step"
    throw $Message
}

function Invoke-LoggedScript {
    param(
        [Parameter(Mandatory = $true)][string]$ScriptPath,
        [Parameter(Mandatory = $true)][string]$LogStem
    )
    if (-not (Test-Path -LiteralPath $ScriptPath)) {
        throw "缺少脚本：$ScriptPath"
    }

    $stdout = Join-Path $logDir "$LogStem.stdout.log"
    $stderr = Join-Path $logDir "$LogStem.stderr.log"
    $proc = Start-Process -FilePath "powershell.exe" `
        -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $ScriptPath) `
        -WorkingDirectory $repoPath `
        -WindowStyle Hidden `
        -Wait `
        -PassThru `
        -RedirectStandardOutput $stdout `
        -RedirectStandardError $stderr

    if ($proc.ExitCode -ne 0) {
        throw "$LogStem 退出码为 $($proc.ExitCode)，日志：$stderr"
    }
}

try {
    $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
    if (-not $service) {
        $installer = Join-Path $repoPath "scripts\install-local-mysql-complete.ps1"
        Invoke-LoggedScript -ScriptPath $installer -LogStem "finalize-install"
        $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
    }

    if (-not $service) {
        Fail-Step -Step "01-service" -Message "本地 MySQL 服务 $serviceName 未安装。"
    }
    if ($service.Status -ne "Running") {
        Start-Service -Name $serviceName
        $service.WaitForStatus("Running", [TimeSpan]::FromSeconds(30))
    }
    Write-Step -Name "01-service.ok" -Value "OK"

    $deadline = (Get-Date).AddSeconds(30)
    $portReady = $false
    do {
        try {
            $client = [System.Net.Sockets.TcpClient]::new()
            $connectTask = $client.ConnectAsync("127.0.0.1", 3306)
            if ($connectTask.Wait(1000) -and $client.Connected) {
                $portReady = $true
            }
            $client.Dispose()
        } catch {
            $portReady = $false
        }
        if (-not $portReady) { Start-Sleep -Milliseconds 500 }
    } while (-not $portReady -and (Get-Date) -lt $deadline)

    if (-not $portReady) {
        Fail-Step -Step "02-port" -Message "本地 MySQL 服务已存在，但 127.0.0.1:3306 未监听。"
    }
    Write-Step -Name "02-port.ok" -Value "OK"

    $configure = Join-Path $repoPath "scripts\configure-local-environment.ps1"
    if (Test-Path -LiteralPath $configure) {
        Invoke-LoggedScript -ScriptPath $configure -LogStem "finalize-environment"
    }

    if (-not (Test-Path -LiteralPath $envFile)) {
        Fail-Step -Step "03-env" -Message "缺少 .env.local-dev。"
    }
    $envText = Get-Content -LiteralPath $envFile -Raw
    $requiredEnv = @(
        "DB_HOST=127.0.0.1",
        "DB_PORT=3306",
        "DB_USER=xiaoluo_local",
        "DB_NAME=xiaoluo_intent_os",
        "DB_SSL=false",
        "STORAGE_PROVIDER=local",
        "FILE_STORAGE_PROVIDER=local",
        "ADMIN_USERNAME=zhurui",
        "ADMIN_PASSWORD=88886666"
    )
    foreach ($entry in $requiredEnv) {
        if ($envText -notmatch "(?m)^$([regex]::Escape($entry))\s*$") {
            Fail-Step -Step "03-env" -Message ".env.local-dev 缺少本地配置：$entry"
        }
    }
    if ($envText -match "(?m)^DB_HOST=(?!127\.0\.0\.1|localhost)\S+") {
        Fail-Step -Step "03-env" -Message ".env.local-dev 仍指向远程 MySQL。"
    }
    if ($envText -match "(?m)^OSS_(ACCESS_KEY_ID|ACCESS_KEY_SECRET|BUCKET|ENDPOINT|REGION)=\S+") {
        Fail-Step -Step "03-env" -Message ".env.local-dev 仍启用了 OSS。"
    }
    Write-Step -Name "03-env.ok" -Value "OK"

    $bootstrap = Join-Path $repoPath "scripts\bootstrap-local-mysql-and-admin.ps1"
    Invoke-LoggedScript -ScriptPath $bootstrap -LogStem "finalize-bootstrap"
    Write-Step -Name "04-database.ok" -Value "OK"
    Write-Step -Name "05-admin.ok" -Value "OK"

    $nodeExe = "C:\Users\Zh\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
    $startScript = Join-Path $repoPath "scripts\start-local-detached.mjs"
    if (-not (Test-Path -LiteralPath $nodeExe)) {
        Fail-Step -Step "06-app" -Message "未找到本地 Node.js 运行时。"
    }
    if (-not (Test-Path -LiteralPath $startScript)) {
        Fail-Step -Step "06-app" -Message "未找到本地启动脚本。"
    }

    $appLog = Join-Path $repoPath ".local-services\app"
    New-Item -ItemType Directory -Force -Path $appLog | Out-Null
    $appStdout = Join-Path $appLog "finalize.stdout.log"
    $appStderr = Join-Path $appLog "finalize.stderr.log"
    Start-Process -FilePath $nodeExe `
        -ArgumentList @("--env-file=.env.local-dev", $startScript) `
        -WorkingDirectory $repoPath `
        -WindowStyle Hidden `
        -RedirectStandardOutput $appStdout `
        -RedirectStandardError $appStderr | Out-Null

    $appReady = $false
    $appDeadline = (Get-Date).AddSeconds(90)
    do {
        try {
            $response = Invoke-WebRequest -Uri "http://127.0.0.1:3001/" -UseBasicParsing -TimeoutSec 3
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
                $appReady = $true
            }
        } catch {
            Start-Sleep -Seconds 1
        }
    } while (-not $appReady -and (Get-Date) -lt $appDeadline)

    if (-not $appReady) {
        Fail-Step -Step "06-app" -Message "数据库已完成，但应用未能在 90 秒内响应 http://127.0.0.1:3001/。"
    }
    Write-Step -Name "06-app.ok" -Value "OK"

    @(
        "STATUS=OK"
        "MYSQL_SERVICE=RUNNING"
        "MYSQL_PORT=127.0.0.1:3306"
        "DATABASE=xiaoluo_intent_os"
        "ADMIN_USERNAME=zhurui"
        "ADMIN_READY=YES"
        "STORAGE=LOCAL"
        "REMOTE_MYSQL=DISABLED"
        "OSS=DISABLED"
        "APP=http://127.0.0.1:3001/"
    ) | Set-Content -LiteralPath (Join-Path $stateDir "FINAL_STATUS.txt") -Encoding utf8
} catch {
    if (-not (Test-Path -LiteralPath (Join-Path $stateDir "FINAL_STATUS.txt"))) {
        Write-Step -Name "FINAL_STATUS.txt" -Value "FAILED:UNEXPECTED"
    }
    throw
}
