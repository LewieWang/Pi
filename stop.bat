@echo off
rem Pi WebUI stopper - kills the service listening on port 3210
rem Usage: double-click this file, or run: stop.bat [port]
rem Default port: 3210

set PORT=%~1
if "%PORT%"=="" set PORT=3210

echo Looking for Pi WebUI on port %PORT% ...

set PID=
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PORT% " ^| findstr "LISTENING"') do (
    set PID=%%a
)

if "%PID%"=="" (
    echo No service found on port %PORT%. Nothing to stop.
    pause
    exit /b 0
)

echo Found process PID=%PID%, stopping...
taskkill /PID %PID% /F

if %errorlevel%==0 (
    echo Pi WebUI stopped.
) else (
    echo Failed to stop process. Try running as Administrator.
)
pause
