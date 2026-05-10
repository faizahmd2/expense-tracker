#!/usr/bin/env bash

PID_FILE="data/server.pid"

if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  kill $PID && rm -f "$PID_FILE"
  echo "🛑 Server stopped"
else
  echo "No running server found"
fi