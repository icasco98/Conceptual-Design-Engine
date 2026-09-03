@echo off
REM One-click start for Windows. Double-click this file. It installs whatever
REM the app needs into this folder and then starts; the first run does the
REM real work, later runs only check. Close the window to stop.
setlocal
cd /d "%~dp0"

where py >nul 2>nul || where python >nul 2>nul || (
  echo Python is not installed. Get it from https://www.python.org/downloads/ ^(3.10 or newer^), tick "Add python.exe to PATH", and run this again.
  pause & exit /b 1
)
where npm >nul 2>nul || (
  echo Node.js is not installed. Get it from https://nodejs.org/ ^(LTS^) and run this again.
  pause & exit /b 1
)

if not exist .env (
  copy .env.example .env >nul
  echo Created .env - open it in Notepad and paste your Anthropic API key after ANTHROPIC_API_KEY=
  echo The diagram works without it; the chat needs it.
)

if not exist .venv (
  echo Setting up Python ^(first run only^)...
  where py >nul 2>nul && (py -3 -m venv .venv) || (python -m venv .venv)
)
call .venv\Scripts\activate.bat
python -m pip install -q --upgrade pip
pip install -q -r requirements.txt

echo Building the screen ^(frontend^)...
pushd frontend
REM Install every time, not only when node_modules is missing. Skipping it
REM once the folder exists means a version of the app that needs a new
REM package never gets it, and the build then fails on an import that looks
REM fine. npm returns in about a second when it is already satisfied.
call npm install --no-audit --no-fund
if errorlevel 1 (
  popd
  echo.
  echo Could not install what the screen needs. Check your internet connection and run this again.
  pause & exit /b 1
)
call npm run build
if errorlevel 1 (
  popd
  echo.
  echo The screen failed to build, so the app was not started. The error is above.
  echo Nothing is broken on your machine - send that message and it can be fixed.
  pause & exit /b 1
)
popd

echo Starting. Your browser will open at http://localhost:8000 - close this window to stop.
start "" http://localhost:8000
python -m uvicorn api.main:app --host 127.0.0.1 --port 8000
pause
