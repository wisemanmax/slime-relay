@echo off
REM ============================================================
REM  SlimeWatch Server - one-click setup + run (Windows)
REM  Double-click this file. It installs everything the first
REM  time, then just starts the server on every run after.
REM ============================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"
title SlimeWatch Server

echo(
echo   ========================================
echo      SlimeWatch Server
echo   ========================================
echo(

REM --- 1) Make sure Node.js is installed -----------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Trying to install it automatically...
  where winget >nul 2>nul
  if errorlevel 1 (
    echo(
    echo   Windows can't auto-install it on this PC. Please install Node.js from:
    echo       https://nodejs.org   ^(click the big "LTS" button, run the installer^)
    echo   then double-click this file again.
    start "" https://nodejs.org
    echo(
    pause
    exit /b 1
  )
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  REM winget puts Node on PATH, but not for THIS window - add the default location.
  set "PATH=%PATH%;%ProgramFiles%\nodejs\;%ProgramFiles(x86)%\nodejs\"
  where node >nul 2>nul
  if errorlevel 1 (
    echo(
    echo   Node was installed but this window can't see it yet.
    echo   Please CLOSE this window and double-click the file again.
    echo(
    pause
    exit /b 1
  )
)
for /f "delims=" %%v in ('node -v') do echo Using Node %%v

REM --- 2) Install dependencies (first run only) ---------------------
if not exist "node_modules\" (
  echo(
  echo Installing dependencies. The first time this downloads a browser
  echo ^(~150 MB^), so give it 2-3 minutes...
  call npm install
  if errorlevel 1 (
    echo(
    echo   Dependency install failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)

REM --- 3) First-run configuration ----------------------------------
if not exist ".env" (
  echo(
  echo Let's set up your server ^(you'll paste the token + relay URL your host gave you^):
  echo(
  node setup.js
  if errorlevel 1 ( pause & exit /b 1 )
)

REM --- 4) Quick health check, then run -----------------------------
echo(
echo Checking everything is ready...
node doctor.js
echo(
echo ------------------------------------------------------------
echo  Starting the server. KEEP THIS WINDOW OPEN to stay online.
echo  Close it (or press Ctrl+C) when you want to stop.
echo ------------------------------------------------------------
echo(
node server.js

echo(
echo Server stopped.
pause
