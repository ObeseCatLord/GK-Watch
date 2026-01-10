@echo off
REM GK Watcher Launch Script for Windows
REM This script starts both the backend server and frontend dev server

echo 🚀 Starting GK Watcher...

REM Get the directory where this script is located
cd /d "%~dp0"

REM Start the backend server in a new window
echo Starting backend server...
start "GK Watcher Backend" cmd /c "cd server && node server.js"

REM Wait a moment for backend to start
timeout /t 2 /nobreak > nul

REM Start the frontend dev server in a new window
echo Starting frontend...
start "GK Watcher Frontend" cmd /c "cd client && npm run dev"

echo.
echo ✅ GK Watcher is running!
echo    Backend:  http://localhost:3000
echo    Frontend: http://localhost:5173
echo.
echo Close the server windows to stop, or press any key to exit this launcher.
pause > nul
