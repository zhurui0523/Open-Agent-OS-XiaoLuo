param(
    [string]$EnvironmentFile = ".env.local-dev"
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$envPath = Join-Path $repoRoot $EnvironmentFile
$localStoragePath = Join-Path $repoRoot ".local-data\storage"

New-Item -ItemType Directory -Path $localStoragePath -Force | Out-Null

$managedKeys = @(
    "DB_HOST",
    "DB_PORT",
    "DB_USER",
    "DB_PASSWORD",
    "DB_NAME",
    "DB_SSL",
    "DB_SSL_CA",
    "DATABASE_URL",
    "SECRET_ENCRYPTION_KEY",
    "STORAGE_PROVIDER",
    "STORAGE_DRIVER",
    "FILE_STORAGE_PROVIDER",
    "FILE_STORAGE_DRIVER",
    "LOCAL_STORAGE_PATH",
    "LOCAL_FILE_STORAGE_PATH",
    "OSS_REGION",
    "OSS_ENDPOINT",
    "OSS_ACCESS_KEY_ID",
    "OSS_ACCESS_KEY_SECRET",
    "OSS_BUCKET",
    "OSS_SECURE",
    "CLOUDFLARE_ENV"
)

$existingLines = @()
if (Test-Path -LiteralPath $envPath) {
    $existingLines = Get-Content -LiteralPath $envPath
}

$secretEncryptionKey = ""
foreach ($line in $existingLines) {
    if ($line -match "^\s*SECRET_ENCRYPTION_KEY\s*=\s*(.+?)\s*$") {
        $secretEncryptionKey = $Matches[1]
        break
    }
}
if (-not $secretEncryptionKey) {
    $secretBytes = New-Object byte[] 32
    $random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $random.GetBytes($secretBytes)
    } finally {
        $random.Dispose()
    }
    $secretEncryptionKey = [Convert]::ToBase64String($secretBytes)
}

$filteredLines = foreach ($line in $existingLines) {
    $trimmed = $line.Trim()
    $isManaged = $false
    foreach ($key in $managedKeys) {
        if ($trimmed -match ("^" + [regex]::Escape($key) + "\s*=")) {
            $isManaged = $true
            break
        }
    }
    if (-not $isManaged) {
        $line
    }
}

$localStorageValue = $localStoragePath.Replace("\", "/")
$localValues = @(
    "",
    "# Local-only database and storage",
    "DB_HOST=127.0.0.1",
    "DB_PORT=3306",
    "DB_USER=xiaoluo_local",
    "DB_PASSWORD=XiaoLuoLocal_88886666",
    "DB_NAME=xiaoluo_intent_os",
    "DB_SSL=false",
    "DB_SSL_CA=",
    "DATABASE_URL=mysql://xiaoluo_local:XiaoLuoLocal_88886666@127.0.0.1:3306/xiaoluo_intent_os",
    "SECRET_ENCRYPTION_KEY=$secretEncryptionKey",
    "STORAGE_PROVIDER=local",
    "STORAGE_DRIVER=local",
    "CLOUDFLARE_ENV=local-dev",
    "FILE_STORAGE_PROVIDER=local",
    "FILE_STORAGE_DRIVER=local",
    "LOCAL_STORAGE_PATH=$localStorageValue",
    "LOCAL_FILE_STORAGE_PATH=$localStorageValue",
    "OSS_REGION=",
    "OSS_ENDPOINT=",
    "OSS_ACCESS_KEY_ID=",
    "OSS_ACCESS_KEY_SECRET=",
    "OSS_BUCKET=",
    "OSS_SECURE=false",
    "ADMIN_USERNAME=zhurui",
    "ADMIN_PASSWORD=88886666",
    "ADMIN_EMAIL=117186209@qq.com",
    "ADMIN_PHONE=18550570523",
    "ADMIN_DISPLAY_NAME=zhurui"
)

$content = @($filteredLines) + $localValues
Set-Content -LiteralPath $envPath -Value $content -Encoding UTF8
