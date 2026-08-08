@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo.
echo ================================
echo  GK Watcher Deployment Setup
echo ================================

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js was not found. Install Node.js 20.18.1 through 26.x.
    goto failure
)
where npm >nul 2>nul
if errorlevel 1 (
    echo [ERROR] npm was not found in PATH.
    goto failure
)

call node scripts\gkwatch-tasks.mjs doctor
if errorlevel 1 goto failure

if /i "%~1"=="--check" (
    echo [OK] deploy.bat prerequisites passed.
    exit /b 0
)

call node scripts\gkwatch-tasks.mjs setup
if errorlevel 1 goto failure

echo.
echo Deployment setup complete.
echo Start with: start.bat --production
if not "%GKWATCH_NO_PAUSE%"=="1" pause
exit /b 0

:failure
set "EXIT_CODE=%ERRORLEVEL%"
if "%EXIT_CODE%"=="0" set "EXIT_CODE=1"
echo.
echo [ERROR] Deployment setup failed. Review the message above.
if not "%GKWATCH_NO_PAUSE%"=="1" pause
exit /b %EXIT_CODE%
