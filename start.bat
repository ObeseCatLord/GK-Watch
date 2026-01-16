@echo off

echo Starting GK Watcher...

cd /d "%~dp0"

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
echo.
echo Close the server windows to stop, or press any key to exit this launcher.
pause > nul

