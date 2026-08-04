param(
  [Parameter(Mandatory = $true)]
  [string]$NodeExecutable,

  [Parameter(Mandatory = $true)]
  [string]$WorkingDirectory,

  [Parameter(Mandatory = $true)]
  [string]$ArgumentsBase64,

  [Parameter(Mandatory = $true)]
  [string]$StdoutPath,

  [Parameter(Mandatory = $true)]
  [string]$StderrPath,

  [Parameter(Mandatory = $true)]
  [string]$PidPath
)

$ErrorActionPreference = "Stop"

# Some terminal hosts inject both "Path" and "PATH" into the Windows
# environment block. Windows accepts that block, but PowerShell 5.1's
# Start-Process converts it to a case-insensitive dictionary and crashes.
# Normalize the duplicate before Start-Process reads the environment.
$processEnvironment = [Environment]::GetEnvironmentVariables("Process")
$pathValue = [string]$processEnvironment["Path"]
if ([string]::IsNullOrWhiteSpace($pathValue)) {
  $pathValue = [string]$processEnvironment["PATH"]
}
[Environment]::SetEnvironmentVariable("Path", $null, "Process")
[Environment]::SetEnvironmentVariable("PATH", $null, "Process")
[Environment]::SetEnvironmentVariable("Path", $pathValue, "Process")
# The desktop host may inject its own Node launch options. They must not leak
# into the detached application process because flags such as --env-file are
# rejected when Node receives them through NODE_OPTIONS.
[Environment]::SetEnvironmentVariable("NODE_OPTIONS", $null, "Process")

$argumentsJson = [System.Text.Encoding]::UTF8.GetString(
  [System.Convert]::FromBase64String($ArgumentsBase64)
)

$arguments = @(
  (ConvertFrom-Json -InputObject $argumentsJson) |
    ForEach-Object { [string]$_ }
)

$process = Start-Process `
  -FilePath $NodeExecutable `
  -ArgumentList $arguments `
  -WorkingDirectory $WorkingDirectory `
  -WindowStyle Hidden `
  -RedirectStandardOutput $StdoutPath `
  -RedirectStandardError $StderrPath `
  -PassThru

Set-Content -LiteralPath $PidPath -Value ([string]$process.Id) -NoNewline
Write-Output $process.Id
