@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist ".env.local" (
    echo [ERROR] .env.local not found. Copy .env.local.example to .env.local first.
    pause
    exit /b 1
)
echo Starting XiaoLuo server on port 3000 ...
node --env-file=.env.local server.js
pause
