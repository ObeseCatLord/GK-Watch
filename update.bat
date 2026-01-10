@echo off

echo Updating GK Watcher...

echo Pulling latest changes...
git pull

echo Building client...
cd client
call npm install
call npm run build
cd ..

echo.
echo Update complete!
pause
