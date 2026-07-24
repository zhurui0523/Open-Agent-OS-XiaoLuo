@echo off
setlocal
cd /d "%~dp0"

set "NODE_EXE=node"
where node >nul 2>&1
if errorlevel 1 (
  set "NODE_EXE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
)

if not exist "%NODE_EXE%" (
  where "%NODE_EXE%" >nul 2>&1
  if errorlevel 1 (
    echo [XiaoLuo AI] Node.js 22 or newer is required.
    echo Download it from https://nodejs.org/ and run this file again.
    pause
    exit /b 1
  )
)

if not exist "node_modules\vinext\dist\cli.js" (
  echo [XiaoLuo AI] Dependencies are missing. Run npm install first.
  pause
  exit /b 1
)

if not defined DATABASE_DRIVER set "DATABASE_DRIVER=d1"
if not defined STORAGE_DRIVER set "STORAGE_DRIVER=r2"

echo.
echo [XiaoLuo AI] Starting local AI Intent OS...
echo [XiaoLuo AI] Open http://localhost:3001/
echo [XiaoLuo AI] Press Ctrl+C to stop.
echo [XiaoLuo AI] Runtime log: .wrangler\local-dev.log
echo.

if not exist ".wrangler" mkdir ".wrangler"
"%NODE_EXE%" "node_modules\vinext\dist\cli.js" dev --host localhost --port 3001 > ".wrangler\local-dev.log" 2>&1
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
  echo.
  echo [XiaoLuo AI] Local service stopped with an error:
  type ".wrangler\local-dev.log"
  pause
)
exit /b %EXIT_CODE%
