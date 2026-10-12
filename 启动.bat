@echo off
setlocal
set "PATH=%SystemRoot%\System32;%PATH%"
"%SystemRoot%\System32\chcp.com" 65001 >nul
cd /d "%~dp0"
"%SystemRoot%\System32\where.exe" node.exe >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 24.10 or newer, then run this launcher again.
  pause
  exit /b 1
)
node -e "const p=process.versions.node.split('.').map(Number);process.exit(p[0]>24||(p[0]===24&&p[1]>=10)?0:1)"
if errorlevel 1 (
  echo Node.js 24.10 or newer is required.
  pause
  exit /b 1
)
if not exist "node_modules\three\package.json" (
  echo First launch: installing locked dependencies...
  call npm.cmd ci
  if errorlevel 1 (
    echo Dependency installation failed. Check the network and README.md.
    pause
    exit /b 1
  )
)
if not defined PRINT_DETAIL_PORT set "PRINT_DETAIL_PORT=4337"
echo Xingzao workbench: http://127.0.0.1:%PRINT_DETAIL_PORT%/
echo Open the address in your browser. See README.md for cached review.
echo Live tasks require AGH, tools and model assets. See README.md.
if exist ".env" (
  node --env-file=.env src/print-server.mjs
) else (
  node src/print-server.mjs
)
set "XINGZAO_START_EXIT=%ERRORLEVEL%"
if not "%XINGZAO_START_EXIT%"=="0" (
  echo Server failed. See the error above and README.md.
  pause
)
exit /b %XINGZAO_START_EXIT%
