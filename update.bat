@echo off
setlocal

echo Updating GK Watcher...

echo Pulling latest changes...
git pull
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Git pull failed. Please check for conflicts.
    pause
    exit /b 1
)

echo.
echo Updating server dependencies...
cd server
call npm install
if %ERRORLEVEL% neq 0 (
    echo [WARN] npm install failed. Retrying with PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true...
    set PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
    call npm install
    if %ERRORLEVEL% neq 0 (
        echo [ERROR] Failed to install server dependencies.
        pause
        exit /b 1
    )
)
cd ..

echo.
echo Updating client dependencies...
cd client
call npm install
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Failed to install client dependencies.
    pause
    exit /b 1
)

echo.
echo Building client...
call npm run build
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Failed to build client.
    pause
    exit /b 1
)
cd ..

echo.
echo Update complete!
pause
