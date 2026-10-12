@echo off
setlocal
set "PATH=%SystemRoot%\System32;%PATH%"
"%SystemRoot%\System32\chcp.com" 65001 >nul
cd /d "%~dp0"

if not defined XINGZAO_PYTHON_PATH (
  where py.exe >nul 2>nul
  if not errorlevel 1 for /f "delims=" %%I in ('py -3.12 -c "import sys; print(sys.executable)" 2^>nul') do set "XINGZAO_PYTHON_PATH=%%I"
)
if not defined XINGZAO_PYTHON_PATH (
  where python.exe >nul 2>nul
  if not errorlevel 1 for /f "delims=" %%I in ('python.exe -c "import sys; print(sys.executable)" 2^>nul') do set "XINGZAO_PYTHON_PATH=%%I"
)
if not defined XINGZAO_PYTHON_PATH if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" set "XINGZAO_PYTHON_PATH=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
if not defined XINGZAO_PYTHON_PATH goto MissingPython

"%XINGZAO_PYTHON_PATH%" -c "import sys; raise SystemExit(0 if sys.version_info[:2] == (3, 12) else 1)"
if errorlevel 1 goto WrongPython

"%XINGZAO_PYTHON_PATH%" tools\setup\reproduce.py environment --kind cpu-review
if errorlevel 1 goto Failed
data\reconstruction\env-torch-readonly\Scripts\python.exe tools\setup\check_runtime.py --kind cpu-review
if errorlevel 1 goto Failed
"%XINGZAO_PYTHON_PATH%" tools\setup\reproduce.py assets --scope slicer
if errorlevel 1 goto Failed

echo Offline CPU mesh review and PrusaSlicer are ready.
echo Start the workbench with Startup.bat when you want to use the full app.
if defined XINGZAO_NO_PAUSE exit /b 0
pause
exit /b 0

:MissingPython
echo Python 3.12 x64 is required. Install it, or set XINGZAO_PYTHON_PATH to python.exe.
if defined XINGZAO_NO_PAUSE exit /b 1
pause
exit /b 1

:WrongPython
echo The selected Python must be 64-bit version 3.12.
if defined XINGZAO_NO_PAUSE exit /b 1
pause
exit /b 1

:Failed
echo Preparation failed. Keep this window open and save the error for review.
if defined XINGZAO_NO_PAUSE exit /b 1
pause
exit /b 1
