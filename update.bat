@echo off
setlocal

cd /d "%~dp0"

echo Updating GK Watcher...

if not exist ".git" (
    echo [WARN] This folder is not a Git checkout.
    echo [WARN] Skipping git pull and rebuilding the files in this downloaded copy.
    goto after_pull
)

where git >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Git is not installed or is not available in PATH.
    pause
    exit /b 1
)

echo Pulling latest changes...
call git pull --ff-only
if errorlevel 1 (
    echo [ERROR] Git pull failed. Please check for conflicts.
    pause
    exit /b 1
)

:after_pull

echo.
echo Updating server dependencies...
cd server
rem Puppeteer 24 downloads both Chrome and chrome-headless-shell by default.
rem GK Watcher launches normal Chrome; skipping the separate shell avoids
rem install failures from stale or partial shell caches on Windows.
set "PUPPETEER_SKIP_CHROME_HEADLESS_SHELL_DOWNLOAD=true"
call npm install
if errorlevel 1 (
    echo [WARN] npm install failed. Retrying once...
    call npm install
    if errorlevel 1 (
        echo [ERROR] Failed to install server dependencies.
        echo [ERROR] If the error mentions Puppeteer cache, delete "%USERPROFILE%\.cache\puppeteer" and run update.bat again.
        pause
        exit /b 1
    )
)
cd ..

echo.
echo Updating client dependencies...
cd client
call npm install
if errorlevel 1 (
    echo [ERROR] Failed to install client dependencies.
    pause
    exit /b 1
)

echo.
echo Building client...
call npm run build
if errorlevel 1 (
    echo [ERROR] Failed to build client.
    pause
    exit /b 1
)
cd ..

echo.
echo Update complete!
pause
