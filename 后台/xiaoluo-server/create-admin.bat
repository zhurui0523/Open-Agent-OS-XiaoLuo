@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Creating system admin (reads SYSTEM_ADMIN_* from .env.local) ...
node --env-file=.env.local scripts/bootstrap-system-admin.mjs
pause
