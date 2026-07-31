@echo off
setlocal

cd /d "%~dp0"

echo.
echo ================================
echo  GK Watcher Deployment Setup
echo ================================

echo.
echo Checking prerequisites...

where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js not found. Please install Node.js 20.18.1 or newer manually.
    pause
    exit /b 1
)

for /f "tokens=1" %%i in ('node -v') do set NODE_FULL_VER=%%i
echo [OK] Node.js %NODE_FULL_VER% detected.
node -e "const [a,b,c]=process.versions.node.split('.').map(Number);const ok=(a===20^&^&(b^>18^|^|(b===18^&^&c^>=1)))^|^|(a^>20^&^&a^<27);process.exit(ok?0:1)"
if errorlevel 1 (
    echo [ERROR] Node.js 20.18.1 through 26.x is required.
    pause
    exit /b 1
)

where git >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [WARN] Git not found. Skipping Git checks...
) else (
    echo [OK] Git detected.
)

echo.
echo Installing server dependencies...
cd server
rem GK Watcher uses an installed Chrome or Chromium executable.
set "PUPPETEER_SKIP_DOWNLOAD=true"
call npm ci
if errorlevel 1 (
    echo [WARN] npm ci failed. Retrying once...
    call npm ci
    if errorlevel 1 (
        echo [ERROR] Failed to install server dependencies. Please check your internet connection or proxy settings.
        echo [ERROR] If the error mentions Puppeteer cache, delete "%USERPROFILE%\.cache\puppeteer" and run deploy.bat again.
        pause
        exit /b 1
    )
)
call npm audit --omit=dev --audit-level=high
if errorlevel 1 exit /b 1
call npm test -- --runInBand
if errorlevel 1 exit /b 1
cd ..

echo.
echo Installing client dependencies...
cd client
call npm ci
if errorlevel 1 (
    echo [ERROR] Failed to install client dependencies.
    pause
    exit /b 1
)
call npm audit --omit=dev --audit-level=high
if errorlevel 1 exit /b 1
call npm run lint
if errorlevel 1 exit /b 1
call npm test -- --run
if errorlevel 1 exit /b 1

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
