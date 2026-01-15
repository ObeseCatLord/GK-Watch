@echo off
setlocal

echo.
echo ================================
echo  GK Watcher Deployment Setup
echo ================================

echo.
echo Checking prerequisites...

where node >nul 2>nul
if %ERRORLEVEL% neq 0 goto :InstallNode
for /f "tokens=1" %%i in ('node -v') do echo [OK] Node.js %%i
goto :CheckNpm

:InstallNode
echo [INFO] Node.js not found.
where winget >nul 2>nul
if %ERRORLEVEL% neq 0 goto :ManualNode

echo [INFO] Attempting auto-install via Winget...
winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
if %ERRORLEVEL% neq 0 goto :ManualNode

echo [OK] Node.js installed. Please RESTART this script to apply changes.
pause
exit /b 0

:ManualNode
echo [ERROR] Automatic install failed.
echo         Please install Node.js 18+ manually from: https://nodejs.org/
pause
exit /b 1


:CheckNpm
where npm >nul 2>nul
if %ERRORLEVEL% neq 0 goto :MissingNpm
for /f "tokens=1" %%i in ('npm -v') do echo [OK] npm %%i
goto :CheckGit

:MissingNpm
echo [ERROR] npm is not installed (it should come with Node.js).
pause
exit /b 1


:CheckGit
where git >nul 2>nul
if %ERRORLEVEL% neq 0 goto :InstallGit
for /f "tokens=3" %%i in ('git --version') do echo [OK] Git %%i
goto :InstallDeps

:InstallGit
echo [INFO] Git not found.
where winget >nul 2>nul
if %ERRORLEVEL% neq 0 goto :ManualGit

echo [INFO] Attempting auto-install of Git...
winget install -e --id Git.Git --accept-source-agreements --accept-package-agreements
if %ERRORLEVEL% neq 0 goto :ManualGit

echo [OK] Git installed. Please RESTART this script via new terminal.
pause
exit /b 0

:ManualGit
echo [WARN] Git install failed or skipped. Continuing without Git...
goto :InstallDeps


:InstallDeps
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
