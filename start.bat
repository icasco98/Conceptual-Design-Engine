@echo off
REM One-click start for Windows. Double-click this file. First run installs
REM everything into this folder; later runs are quick. Close the window to stop.
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
if not exist node_modules call npm install --no-audit --no-fund
call npm run build --silent
popd

echo Starting. Your browser will open at http://localhost:8000 - close this window to stop.
start "" http://localhost:8000
python -m uvicorn api.main:app --host 127.0.0.1 --port 8000
pause
