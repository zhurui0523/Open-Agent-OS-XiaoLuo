$ErrorActionPreference = "SilentlyContinue"

$lines = New-Object System.Collections.Generic.List[string]
function Add-Line([string]$value) {
    $lines.Add($value)
}

Add-Line "XiaoLuo local MySQL diagnostic"
Add-Line ("Time: " + (Get-Date -Format "yyyy-MM-dd HH:mm:ss"))
Add-Line ("CWD: " + (Get-Location).Path)
Add-Line ""

$mysqlServices = Get-Service | Where-Object {
    $_.Name -match "mysql|maria" -or $_.DisplayName -match "mysql|maria"
}
Add-Line ("MySQL services: " + ($(if ($mysqlServices) {
    ($mysqlServices | ForEach-Object { "$($_.Name)=$($_.Status)" }) -join ", "
} else {
    "NONE"
})))

$port = Get-NetTCPConnection -LocalPort 3306 -State Listen
Add-Line ("Port 3306 listening: " + [bool]$port)
Add-Line ("winget: " + [bool](Get-Command winget))
Add-Line ("choco: " + [bool](Get-Command choco))
Add-Line ("docker: " + [bool](Get-Command docker))
Add-Line ("mysql client: " + [bool](Get-Command mysql))
Add-Line ""

Add-Line "Root files:"
Get-ChildItem -LiteralPath . -Force | Select-Object -First 35 | ForEach-Object {
    Add-Line ("  " + $_.Name)
}
Add-Line ""

Add-Line "Candidate scripts:"
Get-ChildItem -LiteralPath .\scripts -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match "mysql|database|db|schema|migrat|seed|admin|local|start" } |
    Select-Object -First 50 |
    ForEach-Object { Add-Line ("  scripts/" + $_.Name) }
Add-Line ""

if (Test-Path -LiteralPath .\package.json) {
    Add-Line "package.json scripts:"
    $package = Get-Content -LiteralPath .\package.json -Raw | ConvertFrom-Json
    $package.scripts.PSObject.Properties | ForEach-Object {
        Add-Line ("  " + $_.Name + " = " + [string]$_.Value)
    }
}
Add-Line ""

Add-Line "Local env keys (values hidden):"
foreach ($envFile in @(".env.local-dev", ".env.local", ".env")) {
    if (Test-Path -LiteralPath $envFile) {
        Add-Line ("  [" + $envFile + "]")
        Get-Content -LiteralPath $envFile |
            Where-Object { $_ -match "^[A-Za-z_][A-Za-z0-9_]*=" } |
            ForEach-Object {
                Add-Line ("    " + (($_ -split "=", 2)[0]))
            }
    }
}

$font = New-Object System.Drawing.Font("Consolas", 11)
$lineHeight = 19
$width = 1400
$height = [Math]::Max(900, ($lines.Count + 3) * $lineHeight)
$bitmap = New-Object System.Drawing.Bitmap($width, $height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.Clear([System.Drawing.Color]::White)
$brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(25, 35, 55))

$y = 20
foreach ($line in $lines) {
    $graphics.DrawString($line, $font, $brush, 20, $y)
    $y += $lineHeight
}

$outputDir = Join-Path (Get-Location).Path "outputs"
New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
$outputPath = Join-Path $outputDir "codex-local-mysql-diagnostic.png"
$bitmap.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)

$brush.Dispose()
$graphics.Dispose()
$bitmap.Dispose()
$font.Dispose()
