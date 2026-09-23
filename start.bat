@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo   ==========================================
echo     Jev Demo - local server
echo   ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   [ERROR] Node.js not found in PATH.
  echo   Install Node.js 18+ from https://nodejs.org first, then retry.
  echo.
  pause
  exit /b 1
)

echo   Starting server... open http://localhost:3000 in your browser
echo   Keep this window OPEN while using the page.
echo   API Key: fill it in the page (stored in your browser only),
echo            or set env var TYPESAFE_API_KEY before starting.
echo   Press Ctrl+C to stop.
echo.

node server.js

echo.
echo   Server stopped.
pause
