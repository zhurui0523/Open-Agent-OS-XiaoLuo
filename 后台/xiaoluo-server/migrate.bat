@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Running database migration ...
node --env-file=.env.local scripts/migrate-v2.mjs
pause
