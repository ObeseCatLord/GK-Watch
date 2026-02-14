@echo off

echo Starting GK Watcher...

cd /d "%~dp0"

if not exist "server\node_modules" (
    echo [ERROR] Server dependencies not found.
    echo         Please run deploy.bat first!
    pause
    exit /b 1
)

:: Check if client is built (Production Mode)
if exist "client\dist\index.html" (
    echo [INFO] Client build found. Starting in PRODUCTION mode...
    echo.
    echo Starting server (backend serves frontend)...
    start "GK Watcher" cmd /c "cd server && node server.js"

    timeout /t 3 /nobreak > nul
    echo.
    echo GK Watcher is running at http://localhost:3000
    start http://localhost:3000
) else (
    echo [INFO] Client build NOT found. Starting in DEV mode...
    echo.

    echo Starting backend server...
    start "GK Watcher Backend" cmd /c "cd server && node server.js"

    timeout /t 2 /nobreak > nul

    echo Starting frontend...
    start "GK Watcher Frontend" cmd /c "cd client && npm run dev"

    echo.
    echo GK Watcher is running!
    echo    Backend:  http://localhost:3000
    echo    Frontend: http://localhost:5173
    echo.

    echo Opening browser...
    timeout /t 4 /nobreak > nul
    start http://localhost:5173
)

echo.
echo Close the server window(s) to stop.
pause > nul
