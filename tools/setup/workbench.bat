@echo off
setlocal
cd /d "%~dp0..\.."
where node.exe >nul 2>nul
if errorlevel 1 goto MissingNode
node -e "const p=process.versions.node.split('.').map(Number);process.exit(p[0]>24||(p[0]===24&&p[1]>=10)?0:1)"
if errorlevel 1 goto MissingNode
if not exist "node_modules\three\package.json" goto Install
if not exist "node_modules\@jscad\modeling\package.json" goto Install
if not exist "node_modules\@jscad\stl-serializer\package.json" goto Install
goto Run
:Install
echo 首次运行，正在安装固定版本的前端依赖...
call npm.cmd ci
if errorlevel 1 exit /b 1
:Run
if not defined PRINT_DETAIL_PORT set "PRINT_DETAIL_PORT=4337"
if not defined PHOTO_CAD_AGH_HOME set "PHOTO_CAD_AGH_HOME=%USERPROFILE%\.agh-print-detail-v2"
echo 工作台地址：http://127.0.0.1:%PRINT_DETAIL_PORT%/
echo 保持此窗口打开；关闭窗口会停止工作台。
if exist ".env" (node --env-file=.env src/print-server.mjs) else (node src/print-server.mjs)
exit /b %ERRORLEVEL%
:MissingNode
echo 需要Node.js 24.10以上。完整参赛包已附运行环境；源码用户请先安装Node.js。
exit /b 1
