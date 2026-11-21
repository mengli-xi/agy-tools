@echo off
setlocal

if "%AGY_STATUSLINE_NESTED%"=="1" (
  "%SystemRoot%\System32\more.com" >nul 2>nul
  exit /b 0
)
if "%AGY_HUD_NESTED%"=="1" (
  "%SystemRoot%\System32\more.com" >nul 2>nul
  exit /b 0
)

set "AGY_SL_NODE="
for %%i in (node.exe) do set "AGY_SL_NODE=%%~$PATH:i"
if not defined AGY_SL_NODE (
  echo agy-statusline: node not found on PATH>&2
  exit /b 127
)

"%AGY_SL_NODE%" --disable-warning=ExperimentalWarning "%~dp0..\dist\agy-statusline.mjs" statusline
