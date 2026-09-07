@echo off
setlocal
cd /d "%~dp0"
title KITKARAOKE Agent

where py >nul 2>nul
if errorlevel 1 (
  echo.
  echo No se encontro Python 3 en esta PC.
  echo Instala Python 3.11 o superior desde python.org y marca "Add Python to PATH".
  echo.
  pause
  exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  echo [1/3] Preparando entorno de KITKARAOKE Agent...
  py -3 -m venv .venv
  if errorlevel 1 goto :error
)

echo [2/3] Verificando dependencias...
".venv\Scripts\python.exe" -m pip install --disable-pip-version-check -q -r requirements.txt
if errorlevel 1 goto :error

echo [3/3] Abriendo KITKARAOKE Agent...
".venv\Scripts\python.exe" agent.py
exit /b %errorlevel%

:error
echo.
echo Ocurrio un error preparando KITKARAOKE Agent.
pause
exit /b 1
