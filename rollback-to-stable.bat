@echo off
REM rollback-to-stable.bat - one-click rollback to the v1-stable-insurance tag.
REM
REM This script resets the master branch to the snapshot tagged
REM v1-stable-insurance, force-pushes to GitHub (Cloudflare Pages will
REM auto-deploy the frontend), and re-deploys the PartyKit server.
REM
REM DESTRUCTIVE: commits made on master after the snapshot are erased
REM from GitHub history. Your local git reflog keeps them for ~90 days
REM if you change your mind, but they won't be on the remote anymore.
REM
REM ASCII only - cmd parses .bat with the system ANSI codepage even
REM under chcp 65001; CJK chars in source can be interpreted as stray
REM commands and break the script.

setlocal
cd /d %~dp0

echo ============================================
echo  ROLLBACK to v1-stable-insurance
echo ============================================
echo.
echo  This will:
echo   1. Reset master to the v1-stable-insurance snapshot
echo   2. Force-push to GitHub (Cloudflare auto-deploys frontend)
echo   3. Re-deploy PartyKit server
echo.
echo  Any commits made on master after the snapshot will be
echo  erased from GitHub. Local reflog keeps them ~90 days if
echo  you need to recover.
echo ============================================
echo.
set /p confirm=Type YES (uppercase) to continue, anything else to abort:
if /i not "%confirm%"=="YES" (
    echo.
    echo Aborted - nothing changed.
    pause
    exit /b 0
)

echo.
echo === Step 1/4: fetch latest from GitHub including tags ===
git fetch origin
if errorlevel 1 (
    echo [ERROR] git fetch failed
    pause
    exit /b 1
)
git fetch --tags
if errorlevel 1 (
    echo [ERROR] git fetch --tags failed
    pause
    exit /b 1
)

echo.
echo === Step 2/4: reset master to snapshot ===
git checkout master
if errorlevel 1 (
    echo [ERROR] could not switch to master
    pause
    exit /b 1
)
git reset --hard v1-stable-insurance
if errorlevel 1 (
    echo.
    echo [ERROR] reset failed - is the tag v1-stable-insurance pushed?
    echo Try: git ls-remote --tags origin ^| findstr v1-stable-insurance
    pause
    exit /b 1
)

echo.
echo === Step 3/4: force-push to GitHub ===
git push --force-with-lease origin master
if errorlevel 1 (
    echo.
    echo [ERROR] force push failed
    echo Possible: someone or another worktree pushed to master since
    echo your last fetch. Investigate before retrying.
    pause
    exit /b 1
)

echo.
echo === Step 4/4: re-deploy PartyKit server ===
call npm run deploy
if errorlevel 1 (
    echo.
    echo [ERROR] partykit deploy failed - frontend is at the snapshot
    echo on GitHub but the PartyKit server is still on the broken
    echo version. Try running:  npm run deploy
    echo manually after fixing the partykit auth/connection issue.
    pause
    exit /b 1
)

echo.
echo ============================================
echo  ROLLBACK COMPLETE.
echo  System is back to v1-stable-insurance:
echo   - GitHub master: reset
echo   - Cloudflare Pages: auto-deploys in ~1-2 min
echo   - PartyKit server: re-deployed
echo ============================================
pause
