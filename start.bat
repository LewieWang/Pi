@echo off
rem Pi WebUI launcher
rem Usage: double-click this file, or run: start.bat [project-dir] [port]
rem Default project dir: D:\PI\workspace  (Pi's working directory, change as needed)
rem Default port: 3210

set PROJECT_DIR=%~1
if "%PROJECT_DIR%"=="" set PROJECT_DIR=D:\PI\workspace

set PORT=%~2
if "%PORT%"=="" set PORT=3210

if not exist "%PROJECT_DIR%" mkdir "%PROJECT_DIR%"

echo ================================================
echo  Pi WebUI
echo  Web UI : http://localhost:%PORT%
echo  Pi workdir: %PROJECT_DIR%
echo  (Pi can read/edit files in that directory)
echo  Close this window to stop the service.
echo ================================================

start "" http://localhost:%PORT%
cd /d D:\PI\pi-webui
node server.js --port %PORT% --cwd "%PROJECT_DIR%"
pause
