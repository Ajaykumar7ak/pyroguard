@echo off
title Stop PyroGuard-H
color 0C
echo =====================================================================
echo                STOPPING PYROGUARD-H PROCESSES
echo =====================================================================
echo.

echo Stopping processes on Port 8000 (Backend)...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":8000" ^| findstr "LISTENING"') do (
    taskkill /F /PID %%a >nul 2>&1
)

echo Stopping processes on Port 3000 (Frontend)...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3000" ^| findstr "LISTENING"') do (
    taskkill /F /PID %%a >nul 2>&1
)

echo.
echo =====================================================================
echo  STATUS: All PyroGuard-H services have been STOPPED cleanly.
echo =====================================================================
echo.
pause
