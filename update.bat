@echo off

echo Updating GK Watcher...

echo Pulling latest changes...
git pull https://github.com/ObeseCatLord/GK-Watch


echo Updating server dependencies...
cd server
call npm install
cd ..

echo Building client...
cd client
call npm install
call npm run build
cd ..

echo.
echo Update complete!
pause
