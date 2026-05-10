#!/usr/bin/env bash

set -e

# ── CONFIG ───────────────────────────────────────────────────────────────
ROOT_DIR="/Users/faiz/Desktop/playground/working-repos/expense-tracker"
LOG_DIR="$ROOT_DIR/data"
LOG_FILE="$LOG_DIR/server.log"
ERR_FILE="$LOG_DIR/server-error.log"
PID_FILE="$LOG_DIR/server.pid"

mkdir -p "$LOG_DIR"

# ── LOAD NVM ─────────────────────────────────────────────────────────────
export NVM_DIR="$HOME/.nvm"
source "$NVM_DIR/nvm.sh"

nvm use node > /dev/null

# ── CHECK IF ALREADY RUNNING ─────────────────────────────────────────────
if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if ps -p $PID > /dev/null 2>&1; then
    echo "⚠ Server already running (PID: $PID)"
    exit 0
  else
    echo "⚠ Removing stale PID file"
    rm -f "$PID_FILE"
  fi
fi

# ── START SERVER IN BACKGROUND ───────────────────────────────────────────
echo "🚀 Starting server..."

cd "$ROOT_DIR"

nohup node server/index.js >> "$LOG_FILE" 2>> "$ERR_FILE" &

PID=$!
echo $PID > "$PID_FILE"

sleep 1

if ps -p $PID > /dev/null 2>&1; then
  echo "✓ Server started (PID: $PID)"
  echo "📄 Logs: $LOG_FILE"
else
  echo "❌ Failed to start. Check logs:"
  echo "   $ERR_FILE"
fi

# cloudflared tunnel --url http://localhost:3100