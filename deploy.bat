@echo off

echo.
echo ================================
echo  GK Watcher Deployment Setup
echo ================================

echo.
echo Checking prerequisites...

where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js is not installed.
    echo         Please install Node.js 18+ from: https://nodejs.org/
    pause
    exit /b 1
)
for /f "tokens=1" %%i in ('node -v') do echo [OK] Node.js %%i

where npm >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] npm is not installed.
    pause
    exit /b 1
)
for /f "tokens=1" %%i in ('npm -v') do echo [OK] npm %%i

where git >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [WARN] Git is not installed (optional for updates)
) else (
    for /f "tokens=3" %%i in ('git --version') do echo [OK] Git %%i
)

echo.
echo Installing server dependencies...
cd server
call npm install
cd ..

echo.
echo Installing client dependencies...
cd client
call npm install

echo.
echo Building client...
call npm run build
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
