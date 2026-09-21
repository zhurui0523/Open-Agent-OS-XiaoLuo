[CmdletBinding()]
param(
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$projectPath = [System.IO.Path]::GetFullPath($ProjectRoot)
$serviceRoot = Join-Path $projectPath ".local-services\mysql"
$dataPath = Join-Path $serviceRoot "data"
$logPath = Join-Path $serviceRoot "mysql-error.log"
$configPath = Join-Path $serviceRoot "my.ini"
$localStoragePath = Join-Path $projectPath ".local-data\storage"
$statusPath = Join-Path $projectPath "LOCAL_SETUP_STATUS.txt"
$serviceName = "XiaoLuoMySQL"
$databaseName = "xiaoluo_intent_os"
$databaseUser = "xiaoluo_local"
$databasePassword = "XiaoLuoLocal_88886666"
$rootPassword = "XiaoLuoRoot_88886666"

function Write-Status {
    param([string]$Message)
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -LiteralPath $statusPath -Value "[$timestamp] $Message" -Encoding UTF8
}

function Set-EnvironmentFile {
    param(
        [string]$Path,
        [hashtable]$Values
    )

    $lines = [System.Collections.Generic.List[string]]::new()
    if (Test-Path -LiteralPath $Path) {
        foreach ($line in Get-Content -LiteralPath $Path) {
            [void]$lines.Add($line)
        }
    }

    foreach ($key in $Values.Keys) {
        $replacement = "$key=$($Values[$key])"
        $found = $false
        for ($index = 0; $index -lt $lines.Count; $index++) {
            if ($lines[$index] -match "^\s*$([regex]::Escape($key))\s*=") {
                $lines[$index] = $replacement
                $found = $true
            }
        }
        if (-not $found) {
            [void]$lines.Add($replacement)
        }
    }

    Set-Content -LiteralPath $Path -Value $lines -Encoding UTF8
}

function Get-EnvironmentFileValue {
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

function Find-Executable {
    param(
        [string]$Name,
        [string[]]$Candidates
    )

    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }

    foreach ($candidate in $Candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) {
            return $candidate
        }
    }

    $roots = @(
        (Join-Path $env:ProgramFiles "MySQL"),
        (Join-Path ${env:ProgramFiles(x86)} "MySQL"),
        (Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages")
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }

    foreach ($root in $roots) {
        $match = Get-ChildItem -LiteralPath $root -Filter $Name -File -Recurse -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($match) {
            return $match.FullName
        }
    }

    return $null
}

function Wait-ForPort {
    param(
        [int]$Port,
        [int]$Seconds = 90
    )

    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $client = [System.Net.Sockets.TcpClient]::new()
            $wait = $client.ConnectAsync("127.0.0.1", $Port)
            if ($wait.Wait(500) -and $client.Connected) {
                $client.Dispose()
                return $true
            }
            $client.Dispose()
        } catch {
        }
        Start-Sleep -Milliseconds 750
    }
    return $false
}

function Invoke-MySql {
    param(
        [string]$ClientPath,
        [string]$Password,
        [string]$Sql
    )

    $previousPassword = $env:MYSQL_PWD
    try {
        $env:MYSQL_PWD = $Password
        $Sql | & $ClientPath --protocol=TCP --host=127.0.0.1 --port=3306 --user=root --default-character-set=utf8mb4 --batch
        if ($LASTEXITCODE -ne 0) {
            throw "mysql client exited with code $LASTEXITCODE"
        }
    } finally {
        $env:MYSQL_PWD = $previousPassword
    }
}

try {
    Set-Content -LiteralPath $statusPath -Value "XiaoLuo local setup started." -Encoding UTF8
    Write-Status "Preparing local-only environment."

    New-Item -ItemType Directory -Path $serviceRoot -Force | Out-Null
    New-Item -ItemType Directory -Path $localStoragePath -Force | Out-Null

    $storageEnvPath = $localStoragePath.Replace("\", "/")
    $environmentPath = Join-Path $projectPath ".env.local-dev"
    $secretEncryptionKey = Get-EnvironmentFileValue -Path $environmentPath -Name "SECRET_ENCRYPTION_KEY"
    if (-not $secretEncryptionKey) {
        $secretEncryptionKey = New-SecretEncryptionKey
    }
    $environmentValues = [ordered]@{
        "DB_HOST" = "127.0.0.1"
        "DB_PORT" = "3306"
        "DB_USER" = $databaseUser
        "DB_PASSWORD" = $databasePassword
        "DB_NAME" = $databaseName
        "DB_SSL" = "false"
        "DB_SSL_CA" = ""
        "DATABASE_URL" = "mysql://${databaseUser}:${databasePassword}@127.0.0.1:3306/${databaseName}"
        "SECRET_ENCRYPTION_KEY" = $secretEncryptionKey
        "STORAGE_PROVIDER" = "local"
        "STORAGE_DRIVER" = "local"
        "FILE_STORAGE_PROVIDER" = "local"
        "FILE_STORAGE_DRIVER" = "local"
        "LOCAL_STORAGE_PATH" = $storageEnvPath
        "LOCAL_FILE_STORAGE_PATH" = $storageEnvPath
        "OSS_REGION" = ""
        "OSS_ACCESS_KEY_ID" = ""
        "OSS_ACCESS_KEY_SECRET" = ""
        "OSS_BUCKET" = ""
        "OSS_ENDPOINT" = ""
        "ADMIN_USERNAME" = "zhurui"
        "ADMIN_PASSWORD" = "88886666"
        "ADMIN_EMAIL" = "117186209@qq.com"
        "ADMIN_PHONE" = "18550570523"
        "ADMIN_DISPLAY_NAME" = "zhurui"
    }
    Set-EnvironmentFile -Path $environmentPath -Values $environmentValues
    Write-Status "Local environment file configured; remote MySQL and OSS disabled."

    $serverCandidates = @(
        (Join-Path $env:ProgramFiles "MySQL\MySQL Server 8.4\bin\mysqld.exe"),
        (Join-Path $env:ProgramFiles "MySQL\MySQL Server 8.0\bin\mysqld.exe")
    )
    $clientCandidates = @(
        (Join-Path $env:ProgramFiles "MySQL\MySQL Server 8.4\bin\mysql.exe"),
        (Join-Path $env:ProgramFiles "MySQL\MySQL Server 8.0\bin\mysql.exe")
    )
    $mysqld = Find-Executable -Name "mysqld.exe" -Candidates $serverCandidates
    $mysql = Find-Executable -Name "mysql.exe" -Candidates $clientCandidates

    if (-not $mysqld -or -not $mysql) {
        Write-Status "MySQL binaries not found; installing Oracle MySQL through winget."
        $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
        if (-not $winget) {
            throw "winget is unavailable. Install Microsoft App Installer, then run this script again."
        }

        & $winget.Source install --id Oracle.MySQL --exact --silent --disable-interactivity --accept-package-agreements --accept-source-agreements
        if ($LASTEXITCODE -ne 0) {
            throw "winget could not install Oracle.MySQL (exit code $LASTEXITCODE)."
        }

        $mysqld = Find-Executable -Name "mysqld.exe" -Candidates $serverCandidates
        $mysql = Find-Executable -Name "mysql.exe" -Candidates $clientCandidates
    }

    if (-not $mysqld -or -not $mysql) {
        throw "MySQL was installed but mysqld.exe/mysql.exe could not be located."
    }
    Write-Status "Using MySQL server at $mysqld"

    $basePath = (Split-Path -Parent (Split-Path -Parent $mysqld)).Replace("\", "/")
    $dataConfigPath = $dataPath.Replace("\", "/")
    $logConfigPath = $logPath.Replace("\", "/")
    $config = @"
[client]
port=3306
host=127.0.0.1
default-character-set=utf8mb4

[mysqld]
basedir=$basePath
datadir=$dataConfigPath
port=3306
bind-address=127.0.0.1
mysqlx=0
character-set-server=utf8mb4
collation-server=utf8mb4_0900_ai_ci
skip-name-resolve=ON
log-error=$logConfigPath
pid-file=xiaoluo-mysql.pid
secure-file-priv=""
"@
    Set-Content -LiteralPath $configPath -Value $config -Encoding ASCII

    if (-not (Test-Path -LiteralPath (Join-Path $dataPath "mysql"))) {
        Write-Status "Initializing local MySQL data directory."
        New-Item -ItemType Directory -Path $dataPath -Force | Out-Null
        & $mysqld "--defaults-file=$configPath" --initialize-insecure --console
        if ($LASTEXITCODE -ne 0) {
            throw "mysqld data initialization failed with exit code $LASTEXITCODE."
        }
    } else {
        Write-Status "Existing local MySQL data directory detected; keeping it."
    }

    $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
    if (-not $service) {
        Write-Status "Registering Windows service $serviceName."
        & $mysqld --install $serviceName "--defaults-file=$configPath"
        if ($LASTEXITCODE -ne 0) {
            throw "MySQL Windows service registration failed with exit code $LASTEXITCODE."
        }
        $service = Get-Service -Name $serviceName -ErrorAction Stop
    }

    if ($service.Status -ne "Running") {
        Write-Status "Starting Windows service $serviceName."
        Start-Service -Name $serviceName
    }
    if (-not (Wait-ForPort -Port 3306 -Seconds 90)) {
        throw "Local MySQL service did not open 127.0.0.1:3306. See $logPath"
    }
    Write-Status "Local MySQL is listening on 127.0.0.1:3306."

    $bootstrapSql = @"
CREATE DATABASE IF NOT EXISTS ``$databaseName`` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER IF NOT EXISTS '$databaseUser'@'127.0.0.1' IDENTIFIED BY '$databasePassword';
CREATE USER IF NOT EXISTS '$databaseUser'@'localhost' IDENTIFIED BY '$databasePassword';
ALTER USER '$databaseUser'@'127.0.0.1' IDENTIFIED BY '$databasePassword';
ALTER USER '$databaseUser'@'localhost' IDENTIFIED BY '$databasePassword';
GRANT ALL PRIVILEGES ON ``$databaseName``.* TO '$databaseUser'@'127.0.0.1';
GRANT ALL PRIVILEGES ON ``$databaseName``.* TO '$databaseUser'@'localhost';
FLUSH PRIVILEGES;
"@

    $rootConnected = $false
    try {
        Invoke-MySql -ClientPath $mysql -Password $rootPassword -Sql $bootstrapSql
        $rootConnected = $true
    } catch {
    }
    if (-not $rootConnected) {
        Invoke-MySql -ClientPath $mysql -Password "" -Sql "ALTER USER 'root'@'localhost' IDENTIFIED BY '$rootPassword';"
        Invoke-MySql -ClientPath $mysql -Password $rootPassword -Sql $bootstrapSql
    }
    Write-Status "Database $databaseName and application database account initialized."

    foreach ($entry in $environmentValues.GetEnumerator()) {
        [Environment]::SetEnvironmentVariable($entry.Key, [string]$entry.Value, "Process")
    }

    $configureScript = Join-Path $projectPath "scripts\configure-local-environment.ps1"
    if (Test-Path -LiteralPath $configureScript) {
        Write-Status "Running project local environment configuration."
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $configureScript
        if ($LASTEXITCODE -ne 0) {
            throw "Project local environment configuration failed with exit code $LASTEXITCODE."
        }
    }

    $bootstrapScript = Join-Path $projectPath "scripts\bootstrap-local-mysql-and-admin.ps1"
    if (Test-Path -LiteralPath $bootstrapScript) {
        Write-Status "Running project schema migration and administrator bootstrap."
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $bootstrapScript
        if ($LASTEXITCODE -ne 0) {
            throw "Project database/admin bootstrap failed with exit code $LASTEXITCODE."
        }
    } else {
        $packageJsonPath = Join-Path $projectPath "package.json"
        if (Test-Path -LiteralPath $packageJsonPath) {
            $package = Get-Content -LiteralPath $packageJsonPath -Raw | ConvertFrom-Json
            $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
            if ($npm) {
                $scriptNames = @($package.scripts.PSObject.Properties.Name)
                $migrationScript = @("db:migrate", "migrate", "db:push") | Where-Object { $scriptNames -contains $_ } | Select-Object -First 1
                if ($migrationScript) {
                    Write-Status "Running npm script $migrationScript."
                    & $npm.Source run $migrationScript --prefix $projectPath
                    if ($LASTEXITCODE -ne 0) {
                        throw "Database migration script $migrationScript failed with exit code $LASTEXITCODE."
                    }
                }
                $adminScript = @("admin:init", "admin:bootstrap", "seed:admin", "db:seed") | Where-Object { $scriptNames -contains $_ } | Select-Object -First 1
                if ($adminScript) {
                    Write-Status "Running npm script $adminScript."
                    & $npm.Source run $adminScript --prefix $projectPath
                    if ($LASTEXITCODE -ne 0) {
                        throw "Administrator bootstrap script $adminScript failed with exit code $LASTEXITCODE."
                    }
                }
            }
        }
    }

    $verifySql = "SELECT 1 FROM information_schema.schemata WHERE schema_name='$databaseName';"
    Invoke-MySql -ClientPath $mysql -Password $rootPassword -Sql $verifySql

    Write-Status "SUCCESS"
    Set-Content -LiteralPath (Join-Path $projectPath "LOCAL_SETUP_COMPLETE.txt") -Value @(
        "Local MySQL: ready at 127.0.0.1:3306"
        "Database: $databaseName"
        "Local file storage: $localStoragePath"
        "Administrator username: zhurui"
        "Remote MySQL: disabled"
        "OSS: disabled"
    ) -Encoding UTF8
    exit 0
} catch {
    Write-Status "FAILED: $($_.Exception.Message)"
    Set-Content -LiteralPath (Join-Path $projectPath "LOCAL_SETUP_FAILED.txt") -Value @(
        "Local setup failed."
        "Reason: $($_.Exception.Message)"
        "See: $statusPath"
        "MySQL log (if created): $logPath"
    ) -Encoding UTF8
    exit 1
}
