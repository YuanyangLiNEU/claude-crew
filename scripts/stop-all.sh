#!/bin/bash
# Stop Claude Crew coordinator
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PID_DIR="$ROOT/.pids"

if [ ! -d "$PID_DIR" ]; then
  echo "No coordinator running."
  exit 0
fi

for pidfile in "$PID_DIR"/*.pid; do
  [ -f "$pidfile" ] || continue
  name=$(basename "$pidfile" .pid)
  pid=$(cat "$pidfile")

  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true
    for i in 1 2 3; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null || true
    fi
    echo "Stopped $name (PID $pid)"
  else
    echo "$name already stopped"
  fi

  rm -f "$pidfile"
done
