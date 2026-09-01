@echo off
chcp 65001 >nul
title AURA Launcher

call C:\aryan\env\Scripts\activate.bat
cd /d C:\aryan\Development\AURA\aura

echo.
echo Checking port 8000...

netstat -ano | findstr /R /C:":8000 .*LISTENING" >nul

if %errorlevel%==0 (
    echo.
    echo Port 8000 is already occupied.
    set /p PORT="Enter a different port: "
) else (
    set PORT=8000
)

echo.
echo Starting AURA on port %PORT%...
echo.

python serve.py %PORT% --allow-actions --allow-lan

pause