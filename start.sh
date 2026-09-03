#!/usr/bin/env bash
# One-click start for macOS / Linux. Double-click this file, or run
# `./start.sh` in a terminal. First run installs everything it needs into
# this folder (a Python virtual environment in .venv and the frontend's
# node_modules); later runs are quick. Close the terminal window to stop.
set -euo pipefail
cd "$(dirname "$0")"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; read -r -p "Press Enter to close." _ || true; exit 1; }

command -v python3 >/dev/null 2>&1 || die "Python 3 is not installed. Get it from https://www.python.org/downloads/ (3.10 or newer) and run this again."
command -v npm >/dev/null 2>&1 || die "Node.js is not installed. Get it from https://nodejs.org/ (LTS) and run this again."

if [ ! -f .env ]; then
  cp .env.example .env
  say "Created .env — open it in a text editor and paste your Anthropic API key after ANTHROPIC_API_KEY= (the diagram works without it; the chat needs it)."
fi

if [ ! -d .venv ]; then
  say "Setting up Python (first run only)…"
  python3 -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate
pip install -q --upgrade pip
pip install -q -r requirements.txt

say "Building the screen (frontend)…"
( cd frontend && { [ -d node_modules ] || npm install --no-audit --no-fund; } && npm run build --silent )

say "Starting. Your browser will open at http://localhost:8000 — close this window to stop."
( sleep 2; if command -v xdg-open >/dev/null 2>&1; then xdg-open http://localhost:8000; elif command -v open >/dev/null 2>&1; then open http://localhost:8000; fi ) &
exec python -m uvicorn api.main:app --host 127.0.0.1 --port 8000
