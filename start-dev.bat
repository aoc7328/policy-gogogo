@echo off
chcp 65001 >nul
REM === policy-gogogo dev environment launcher ===

set "PROJECT_DIR=C:\dev\policy-gogogo"

echo.
echo  Starting policy-gogogo dev environment...
echo  Project: %PROJECT_DIR%
echo.

REM 強制 partykit dev 綁 1999;若 port 被佔住會直接報錯而非靜默落到別的 port,
REM 避免「server 跑在 9988 但 client 寫死連 1999」這種無聲斷線。
start "PartyKit (1999)" cmd /k "cd /d %PROJECT_DIR% && npm.cmd run dev -- --port 1999"
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
