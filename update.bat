@echo off
REM GK Watcher Update Script
REM Pulls latest code and rebuilds the client

echo Updating GK Watcher...

REM Pull latest changes
echo Pulling latest changes...
git pull

REM Rebuild client
echo Building client...
cd client
call npm install
call npm run build
cd ..

echo.
echo Update complete!
pause
