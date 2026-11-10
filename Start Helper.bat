@echo off
rem Double-click to start the Fig To Rive helper on Windows. Leave this window open.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get it from https://nodejs.org & pause & exit /b 1)
node helper\start.js
pause
