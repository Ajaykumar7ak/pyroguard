@echo off
title PyroGuard-H Launcher
color 0B
echo =====================================================================
echo                PYROGUARD-H ^| ONE-CLICK LAUNCHER
echo =====================================================================
echo.
echo Starting PyroGuard-H components...
echo.

:: 1. Start Backend in separate window
echo [1/3] Launching Python FastAPI Backend & Vision AI (Port 8000)...
start "PyroGuard Backend [Port 8000]" cmd /k "title PyroGuard Backend && cd /d "%~dp0backend" && venv\Scripts\python.exe -m uvicorn main:app --host 0.0.0.0 --port 8000"

:: 2. Start Frontend in separate window
echo [2/3] Launching React Safety Command Center (Port 3000)...
start "PyroGuard Frontend [Port 3000]" cmd /k "title PyroGuard Frontend && cd /d "%~dp0frontend" && npm run dev -- --host 0.0.0.0 --port 3000"

:: 3. Wait briefly and open browser
echo [3/3] Opening Dashboard in your default browser...
timeout /t 4 /nobreak >nul
start http://localhost:3000/

echo.
echo =====================================================================
echo  STATUS: PyroGuard-H is RUNNING!
echo.
echo  - Dashboard URL: http://localhost:3000/
echo  - Backend API:   http://127.0.0.1:8000/docs
echo.
echo  Tip: Keep the two background terminal windows open while using.
echo       To stop everything, double-click 'stop_pyroguard.bat'.
echo =====================================================================
echo.
pause
