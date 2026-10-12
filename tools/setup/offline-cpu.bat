@echo off
setlocal
cd /d "%~dp0..\.."
if not defined XINGZAO_PYTHON_PATH (
  where py.exe >nul 2>nul
  if not errorlevel 1 for /f "delims=" %%I in ('py -3.12 -c "import sys; print(sys.executable)" 2^>nul') do set "XINGZAO_PYTHON_PATH=%%I"
)
if not defined XINGZAO_PYTHON_PATH if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" set "XINGZAO_PYTHON_PATH=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
if not defined XINGZAO_PYTHON_PATH (
  where python.exe >nul 2>nul
  if not errorlevel 1 for /f "delims=" %%I in ('python.exe -c "import sys; print(sys.executable)" 2^>nul') do set "XINGZAO_PYTHON_PATH=%%I"
)
if not defined XINGZAO_PYTHON_PATH goto MissingPython
"%XINGZAO_PYTHON_PATH%" -c "import sys; raise SystemExit(0 if sys.version_info[:2] == (3, 12) and sys.maxsize > 2**32 else 1)"
if errorlevel 1 goto MissingPython
"%XINGZAO_PYTHON_PATH%" tools\setup\reproduce.py environment --kind cpu-review
if errorlevel 1 exit /b 1
data\reconstruction\env-torch-readonly\Scripts\python.exe tools\setup\check_runtime.py --kind cpu-review
if errorlevel 1 exit /b 1
"%XINGZAO_PYTHON_PATH%" tools\setup\reproduce.py assets --scope slicer
if errorlevel 1 exit /b 1
data\reconstruction\env-torch-readonly\Scripts\python.exe tools\setup\reslice.py
exit /b %ERRORLEVEL%
:MissingPython
echo 此步骤需要Python 3.12 x64。请安装后再选择3。
echo 安装入口：https://www.python.org/downloads/windows/
echo 只查看案例或复核已有刀轨，请选择1或2，不需要Python。
exit /b 1
