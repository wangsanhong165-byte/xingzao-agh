@echo off
setlocal
set "PATH=%SystemRoot%\System32;%PATH%"
"%SystemRoot%\System32\chcp.com" 65001 >nul
cd /d "%~dp0"
"%SystemRoot%\System32\where.exe" node.exe >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 24.10 or newer.
  pause
  exit /b 1
)
node tools/review/run.mjs --open %*
set "XINGZAO_REVIEW_EXIT=%ERRORLEVEL%"
pause
exit /b %XINGZAO_REVIEW_EXIT%
