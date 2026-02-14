@echo off
setlocal

echo.
echo ================================
echo  GK Watcher Deployment Setup
echo ================================

echo.
echo Checking prerequisites...

where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js not found. Please install Node.js 18+ manually.
    pause
    exit /b 1
)

for /f "tokens=1" %%i in ('node -v') do set NODE_FULL_VER=%%i
echo [OK] Node.js %NODE_FULL_VER% detected.

where git >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [WARN] Git not found. Skipping Git checks...
) else (
    echo [OK] Git detected.
)

echo.
echo Installing server dependencies...
cd server
call npm install
if %ERRORLEVEL% neq 0 (
    echo [WARN] npm install failed. Retrying with PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true...
    set PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
    call npm install
    if %ERRORLEVEL% neq 0 (
        echo [ERROR] Failed to install server dependencies. Please check your internet connection or proxy settings.
        pause
        exit /b 1
    )
)
cd ..

echo.
echo Installing client dependencies...
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
echo Setting up data directory...
if not exist "server\data" mkdir server\data

echo.
echo ================================
echo Deployment setup complete!
echo.
echo To start the application, run:
echo   start.bat
echo.
pause
