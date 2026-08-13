[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$desktopRoot = (Resolve-Path $PSScriptRoot).Path
$projectRoot = (Resolve-Path (Join-Path $desktopRoot "..")).Path
$electronPath = Join-Path $projectRoot "node_modules\electron\dist\electron.exe"
$mainScript = Join-Path $desktopRoot "main.mjs"
$iconPath = Join-Path $desktopRoot "assets\xiaoluo.ico"

if (-not (Test-Path -LiteralPath $electronPath)) {
  throw "Electron is not installed. Run pnpm install in the project root first."
}
if (-not (Test-Path -LiteralPath $mainScript)) {
  throw "Desktop entry not found: $mainScript"
}
if (-not (Test-Path -LiteralPath $iconPath)) {
  throw "Desktop icon not found: $iconPath"
}

$desktopDirectory = [Environment]::GetFolderPath("Desktop")
$shortcutName = ([string][char]0x5C0F) + ([string][char]0x903B)
$shortcutPath = Join-Path $desktopDirectory "$shortcutName.lnk"
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $electronPath
$shortcut.Arguments = "`"$mainScript`""
$shortcut.WorkingDirectory = $projectRoot
$shortcut.IconLocation = "$iconPath,0"
$shortcut.Description = "$shortcutName Desktop Workbench"
$shortcut.Save()

Write-Output "desktop_shortcut=$shortcutPath"
