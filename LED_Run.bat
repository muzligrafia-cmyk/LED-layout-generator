@echo off
chcp 65001 >nul
cd /d "%~dp0"
title LED Layout Generator - calculating...

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js was not found on this PC.
  echo   Install it from https://nodejs.org ^(the LTS version^), then run LED_Export.jsx again.
  echo.
  pause
  exit /b
)

rem clipper-lib lives in your user folder, so no admin rights are needed
set "LIBDIR=%LOCALAPPDATA%\LEDLayoutGenerator"
set "NODE_PATH=%LIBDIR%\node_modules"
if not exist "%LIBDIR%\node_modules\clipper-lib" (
  echo.
  echo   First run: installing the geometry library ^(clipper-lib^)... one moment.
  if not exist "%LIBDIR%" mkdir "%LIBDIR%"
  call npm install clipper-lib@6.4.2 --prefix "%LIBDIR%" --no-audit --no-fund --loglevel=error
)

rem find the real Desktop ^(also works when OneDrive moved it^)
set "DESKTOP="
for /f "usebackq delims=" %%D in (`powershell -NoProfile -Command "[Environment]::GetFolderPath('Desktop')"`) do set "DESKTOP=%%D"

node "%~dp0led_engine.cjs" "%DESKTOP%"

title LED Layout Generator - finished
echo   Press any key to close this window.
pause >nul
