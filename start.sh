#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if [ ! -f .env ]; then
  cp .env.example .env
  echo ">>> .env wurde aus .env.example erstellt. Trage dort deinen GEMINI_API_KEY, FAMILY_PASSWORD und PARENT_PIN ein."
fi

if [ ! -d .venv ]; then
  echo ">>> Erstelle Python-Umgebung (.venv)..."
  python3 -m venv .venv
  .venv/bin/pip install -r requirements.txt
fi

PORT="${PORT:-8000}"
if grep -q '^PORT=' .env; then
  PORT="$(grep '^PORT=' .env | tail -n1 | cut -d'=' -f2 | tr -d '\r ')"
fi

LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"

echo ""
echo "=========================================="
echo "  LernBuddy startet!"
echo "  Laptop:       http://localhost:${PORT}"
if [ -n "${LAN_IP}" ]; then
  echo "  Handy/Tablet: http://${LAN_IP}:${PORT}"
fi
echo "=========================================="
echo ""

exec .venv/bin/uvicorn app.main:app --host 0.0.0.0 --port "${PORT}"
