@echo off
chcp 65001 >nul
REM === policy-gogogo dev environment launcher ===

set "PROJECT_DIR=C:\dev\policy-gogogo"

echo.
echo  Starting policy-gogogo dev environment...
echo  Project: %PROJECT_DIR%
echo.

start "PartyKit (1999)" cmd /k "cd /d %PROJECT_DIR% && npm.cmd run dev"
timeout /t 1 /nobreak >nul

start "Static Server (3000)" cmd /k "cd /d %PROJECT_DIR% && npx.cmd serve public -l 3000"

echo  Two server windows started.
echo.
echo  Open browser:
echo    http://localhost:3000/assistant.html
echo    http://localhost:3000/presenter.html
echo    http://localhost:3000/participant.html
echo.
echo  To stop: close server windows or press Ctrl+C in them.
echo.
pause
