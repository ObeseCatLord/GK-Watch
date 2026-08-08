@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js is not installed or is not available in PATH.
    echo Run deploy.bat first.
    goto failure
)

if /i "%~1"=="--check" (
    call node scripts\gkwatch-tasks.mjs doctor --skip-browser
    if errorlevel 1 goto failure
    echo [OK] start.bat prerequisites passed.
    exit /b 0
)

call node scripts\gkwatch-tasks.mjs start %*
if errorlevel 1 goto failure
exit /b 0

:failure
set "EXIT_CODE=%ERRORLEVEL%"
if "%EXIT_CODE%"=="0" set "EXIT_CODE=1"
echo.
echo [ERROR] GK Watcher did not start successfully.
if not "%GKWATCH_NO_PAUSE%"=="1" pause
exit /b %EXIT_CODE%
