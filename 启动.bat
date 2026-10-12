@echo off
setlocal
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
set "PATH=%~dp0data\tools\node-v24.16.0-win-x64;%SystemRoot%\System32;%PATH%"
"%SystemRoot%\System32\chcp.com" 65001 >nul
cd /d "%~dp0"
echo.
echo 形造 - 作品查看与复现
echo  1  查看作品、已完成案例、视频与AGH记录
echo  2  重新复核随包模型和刀轨
echo  3  重新生成标准模型并实际切片
echo  4  启动完整工作台，执行自己的任务
echo  5  打开完整环境与模型配置说明
echo  X  退出
if defined XINGZAO_LAUNCH_ACTION goto Select
choice /c 12345X /n /m "请选择 [1-5/X]："
if errorlevel 6 exit /b 0
set "XINGZAO_LAUNCH_ACTION=%ERRORLEVEL%"
:Select
if "%XINGZAO_LAUNCH_ACTION%"=="1" goto View
if "%XINGZAO_LAUNCH_ACTION%"=="2" goto Review
if "%XINGZAO_LAUNCH_ACTION%"=="3" goto Compute
if "%XINGZAO_LAUNCH_ACTION%"=="4" goto Workbench
if "%XINGZAO_LAUNCH_ACTION%"=="5" goto Guide
exit /b 1
:View
if exist "开始.html" (
 if not defined XINGZAO_NO_OPEN start "" "开始.html"
 exit /b 0
)
if exist "..\开始.html" (
 if not defined XINGZAO_NO_OPEN start "" "..\开始.html"
 exit /b 0
)
goto Guide
:Review
where node.exe >nul 2>nul
if errorlevel 1 goto MissingNode
if defined XINGZAO_NO_OPEN (node tools\review\run.mjs) else (node tools\review\run.mjs --open)
goto Finish
:Compute
call tools\setup\offline-cpu.bat
goto Finish
:Workbench
call tools\setup\workbench.bat
goto Finish
:Guide
if exist "运行与模型配置.html" (if not defined XINGZAO_NO_OPEN start "" "运行与模型配置.html") else (if not defined XINGZAO_NO_OPEN start "" "运行与模型配置.md")
exit /b 0
:MissingNode
echo 需要Node.js 24.10以上。完整参赛包已附；源码用户请先安装Node.js。
exit /b 1
:Finish
set "XINGZAO_LAUNCH_EXIT=%ERRORLEVEL%"
if not "%XINGZAO_LAUNCH_EXIT%"=="0" echo 本步骤未完成，请保留上方错误并按安装说明处理。
if not defined XINGZAO_NO_PAUSE pause
exit /b %XINGZAO_LAUNCH_EXIT%
