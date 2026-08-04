@echo off
setlocal
set "NODE_EXE=C:\Users\Zh\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"
"%NODE_EXE%" "%~dp0scripts\status-local.mjs"
exit /b %ERRORLEVEL%
