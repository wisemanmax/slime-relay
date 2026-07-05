@echo off
REM Loads .env and starts the extractor. Windows (double-click or run from cmd).
cd /d "%~dp0"
powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0start.ps1"
