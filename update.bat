@echo off
setlocal EnableExtensions
cd /d "%~dp0"

if /i "%~1"=="--check" goto check_only

if not "%GKWATCH_UPDATE_AFTER_PULL%"=="1" (
    where git >nul 2>nul
    if errorlevel 1 (
        echo [ERROR] Git is required to download updates.
        goto failure
    )

    call git rev-parse --is-inside-work-tree >nul 2>nul
    if errorlevel 1 (
        echo [ERROR] This copy is not a Git checkout and cannot download updates.
        echo Clone https://github.com/ObeseCatLord/GK-Watch.git to enable in-place updates.
        goto failure
    )

    echo Pulling latest changes...
    call git pull --ff-only
    if errorlevel 1 goto failure

    rem Re-enter the newly pulled script so update logic cannot remain stale.
    set "GKWATCH_UPDATE_AFTER_PULL=1"
    call "%~f0" %*
    if errorlevel 1 exit /b 1
    exit /b 0
)

:after_pull
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js is not installed or is not available in PATH.
    echo Run deploy.bat first.
    goto failure
)
where npm >nul 2>nul
if errorlevel 1 (
    echo [ERROR] npm is not installed or is not available in PATH.
    goto failure
)

call node scripts\gkwatch-tasks.mjs setup
if errorlevel 1 goto failure

echo.
echo Update complete. Restart GK Watcher to run the new version.
if not "%GKWATCH_NO_PAUSE%"=="1" pause
exit /b 0

:check_only
where node >nul 2>nul
if errorlevel 1 goto failure
call node scripts\gkwatch-tasks.mjs doctor --skip-browser
if errorlevel 1 goto failure
echo [OK] update.bat prerequisites passed.
exit /b 0

:failure
set "EXIT_CODE=%ERRORLEVEL%"
if "%EXIT_CODE%"=="0" set "EXIT_CODE=1"
echo.
echo [ERROR] Update failed. Review the message above; no restart was performed.
if not "%GKWATCH_NO_PAUSE%"=="1" pause
exit /b %EXIT_CODE%
