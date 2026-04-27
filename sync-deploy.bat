@echo off
REM Pull latest master then deploy PartyKit server.
REM ASCII only - Chinese in .bat triggers cmd ANSI codepage parser errors.
REM Run this from anywhere; %~dp0 jumps to the script's own folder.

cd /d %~dp0
if errorlevel 1 (
    echo [ERROR] cd to script dir failed
    pause
    exit /b 1
)

echo ============================================
echo  STEP 1/2  Pulling latest master from GitHub
echo ============================================
git pull
if errorlevel 1 (
    echo.
    echo [ERROR] git pull failed - resolve conflicts then retry
    pause
    exit /b 1
)

echo.
echo ============================================
echo  STEP 2/2  Deploying party server to PartyKit
echo ============================================
call npm run deploy
if errorlevel 1 (
    echo.
    echo [ERROR] partykit deploy failed - check the message above
    pause
    exit /b 1
)

echo.
echo ============================================
echo  DONE. Frontend auto-deploys via Cloudflare.
echo  Backend is now live at:
echo  https://policy-gogogo.aoc7328.partykit.dev
echo ============================================
pause
