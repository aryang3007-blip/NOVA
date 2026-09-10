@echo off
chcp 65001 >nul
title AURA
rem AURA :: single portable launcher (replaces Launcher.bat + AURA_Launcher.bat).
rem No hardcoded paths: everything resolves from this file's own folder.
cd /d "%~dp0aura"

rem --- python: prefer a repo venv, else PATH python ---
if exist "%~dp0env\Scripts\activate.bat" (
  call "%~dp0env\Scripts\activate.bat"
) else if exist "%~dp0.venv\Scripts\activate.bat" (
  call "%~dp0.venv\Scripts\activate.bat"
) else if exist ".venv\Scripts\activate.bat" (
  call ".venv\Scripts\activate.bat"
)
where python >nul 2>nul
if %errorlevel% neq 0 (
  echo [AURA] No python found. Install Python 3.8+ and re-run.
  pause
  exit /b 1
)

rem --- port: default 8000, prompt only if occupied ---
set PORT=8000
netstat -ano | findstr /R /C:":8000 .*LISTENING" >nul
if %errorlevel%==0 (
  echo Port 8000 is occupied.
  set /p PORT="Use a different port [8000]: "
  if "%PORT%"=="" set PORT=8000
)

rem --- voice service in a second window when the mic stack exists ---
python -c "import pyaudio" >nul 2>nul
if %errorlevel% neq 0 python -c "import pyaudiowpatch" >nul 2>nul
if %errorlevel%==0 (
  echo Starting voice service in a second window...
  start "AURA voice" /min python voice\wake_service.py --server http://localhost:%PORT%/api/voice/wake
) else (
  echo [AURA] voice service skipped: no mic stack installed.
  echo         For wake word: pip install -r requirements.txt
  echo         Browser wake scanning still works without it.
)

echo Starting AURA on port %PORT%...
python server\serve.py %PORT% --allow-actions --allow-lan
echo.
echo Server stopped.
pause
