@echo off
REM Sync local repo with GitHub then deploy PartyKit server.
REM Frontend (Cloudflare Pages) auto-deploys whenever master is updated
REM on GitHub, so step 2 (push) is what triggers it. Step 3 deploys the
REM PartyKit backend separately.
REM ASCII only - Chinese in .bat triggers cmd ANSI codepage parser errors.

cd /d %~dp0
if errorlevel 1 (
    echo [ERROR] cd to script dir failed
    pause
    exit /b 1
)

echo ============================================
echo  STEP 1/3  Pull latest master from GitHub
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
echo  STEP 2/3  Push local commits (Cloudflare)
echo ============================================
echo  No-op if nothing to push. If there are local
echo  commits, this triggers Cloudflare Pages to
echo  auto-redeploy the frontend.
git push
if errorlevel 1 (
    echo.
    echo [ERROR] git push failed - check auth or remote state
    pause
    exit /b 1
)

echo.
echo ============================================
echo  STEP 3/3  Deploy party server to PartyKit
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
echo  DONE. Both halves are in sync with master:
echo   - Frontend: https://policy-gogogo.pages.dev
echo   - Backend:  https://policy-gogogo.aoc7328.partykit.dev
echo  Cloudflare deploy may take 1-2 minutes to propagate.
echo ============================================
pause
