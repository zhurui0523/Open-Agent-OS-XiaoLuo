$ErrorActionPreference = "Continue"

$workspace = Split-Path -Parent $PSScriptRoot
$lines = [System.Collections.Generic.List[string]]::new()

function Add-Line {
    param([string]$Text = "")
    $lines.Add($Text)
}

Add-Line "Local MySQL diagnostic"
Add-Line ("Time: " + (Get-Date -Format "yyyy-MM-dd HH:mm:ss"))
Add-Line ("Workspace: " + $workspace)
Add-Line ""

Add-Line "== MySQL services =="
$mysqlServices = Get-Service -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match "mysql|maria" -or $_.DisplayName -match "mysql|maria" }
if ($mysqlServices) {
    foreach ($service in $mysqlServices) {
        Add-Line ("{0} | {1} | {2}" -f $service.Name, $service.Status, $service.DisplayName)
    }
} else {
    Add-Line "NONE"
}
Add-Line ""

Add-Line "== Port 3306 =="
$listener = Get-NetTCPConnection -LocalPort 3306 -State Listen -ErrorAction SilentlyContinue
if ($listener) {
    foreach ($item in $listener) {
        Add-Line ("LISTEN {0}:{1} PID={2}" -f $item.LocalAddress, $item.LocalPort, $item.OwningProcess)
    }
} else {
    Add-Line "NOT LISTENING"
}
Add-Line ""

Add-Line "== Executables =="
foreach ($name in @("mysql.exe", "mysqld.exe", "winget.exe")) {
    $command = Get-Command $name -ErrorAction SilentlyContinue
    if ($command) {
        Add-Line ("{0}: {1}" -f $name, $command.Source)
    } else {
        Add-Line ("{0}: NOT FOUND" -f $name)
    }
}
Add-Line ""

Add-Line "== Key project files =="
foreach ($relativePath in @(
    "package.json",
    ".env.local-dev",
    ".env.local",
    "docker-compose.yml",
    "compose.yml",
    "drizzle.config.ts",
    "prisma/schema.prisma"
)) {
    $fullPath = Join-Path $workspace $relativePath
    Add-Line ("{0}: {1}" -f $relativePath, (Test-Path -LiteralPath $fullPath))
}
Add-Line ""

Add-Line "== package.json scripts/dependencies =="
$packagePath = Join-Path $workspace "package.json"
if (Test-Path -LiteralPath $packagePath) {
    try {
        $packageJson = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
        if ($packageJson.scripts) {
            $packageJson.scripts.PSObject.Properties |
                Where-Object { $_.Name -match "db|migrat|seed|start|dev" } |
                ForEach-Object { Add-Line ("script {0}: {1}" -f $_.Name, $_.Value) }
        }
        foreach ($dependencyGroup in @("dependencies", "devDependencies")) {
            $dependencies = $packageJson.$dependencyGroup
            if ($dependencies) {
                $dependencies.PSObject.Properties |
                    Where-Object { $_.Name -match "mysql|drizzle|prisma|sequelize|typeorm|knex" } |
                    ForEach-Object { Add-Line ("{0} {1}: {2}" -f $dependencyGroup, $_.Name, $_.Value) }
            }
        }
    } catch {
        Add-Line ("package.json error: " + $_.Exception.Message)
    }
} else {
    Add-Line "package.json missing"
}
Add-Line ""

Add-Line "== Database-related files =="
$databaseFiles = Get-ChildItem -LiteralPath $workspace -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object {
        $_.FullName -notmatch "\\node_modules\\|\\\.git\\|\\dist\\|\\build\\|\\\.next\\|\\\.local-data\\|\\\.local-logs\\" -and
        ($_.Name -match "migrat|schema|seed|database|mysql|bootstrap|admin")
    } |
    Select-Object -First 80
if ($databaseFiles) {
    foreach ($file in $databaseFiles) {
        Add-Line ($file.FullName.Substring($workspace.Length + 1))
    }
} else {
    Add-Line "NONE"
}
Add-Line ""

Add-Line "== Relevant config references =="
$candidateFiles = Get-ChildItem -LiteralPath $workspace -Recurse -File -Include *.ts,*.tsx,*.js,*.mjs,*.cjs,*.json,*.sql,*.env,*.example -ErrorAction SilentlyContinue |
    Where-Object {
        $_.FullName -notmatch "\\node_modules\\|\\\.git\\|\\dist\\|\\build\\|\\\.next\\|\\\.local-data\\|\\\.local-logs\\"
    }
$matches = $candidateFiles |
    Select-String -Pattern "DB_HOST|DATABASE_URL|DB_NAME|MYSQL|system_admin|SYSTEM_ADMIN|createAdmin|seedAdmin" -ErrorAction SilentlyContinue |
    Select-Object -First 100
if ($matches) {
    foreach ($match in $matches) {
        $relative = $match.Path.Substring($workspace.Length + 1)
        $safeLine = $match.Line -replace "(?i)(password|secret|access_key)(\s*[:=]\s*)[^\s,;]+", '$1$2[REDACTED]'
        Add-Line ("{0}:{1}: {2}" -f $relative, $match.LineNumber, $safeLine.Trim())
    }
} else {
    Add-Line "NONE"
}

$reportPath = Join-Path $workspace ".local-mysql-diagnostic.txt"
[System.IO.File]::WriteAllLines($reportPath, $lines, [System.Text.UTF8Encoding]::new($false))

try {
    Add-Type -AssemblyName System.Drawing
    $font = [System.Drawing.Font]::new("Consolas", 10)
    $lineHeight = 16
    $width = 1800
    $height = [Math]::Max(600, [Math]::Min(12000, ($lines.Count + 4) * $lineHeight))
    $bitmap = [System.Drawing.Bitmap]::new($width, $height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.Clear([System.Drawing.Color]::White)
    $brush = [System.Drawing.Brushes]::Black
    $y = 16
    foreach ($line in $lines) {
        if ($y -gt ($height - $lineHeight)) { break }
        $graphics.DrawString($line, $font, $brush, 16, $y)
        $y += $lineHeight
    }
    $imagePath = Join-Path $workspace ".local-mysql-diagnostic.png"
    $bitmap.Save($imagePath, [System.Drawing.Imaging.ImageFormat]::Png)
    $graphics.Dispose()
    $bitmap.Dispose()
    $font.Dispose()
} catch {
    [System.IO.File]::WriteAllText(
        (Join-Path $workspace ".local-mysql-diagnostic-image-error.txt"),
        $_.Exception.ToString()
    )
}
