#!/bin/bash
# (Re)start Claude Crew coordinator
# One process manages all agents (Telegram bots + routing + dispatch).
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
LOG_DIR="$ROOT/logs"
PID_DIR="$ROOT/.pids"

mkdir -p "$LOG_DIR" "$PID_DIR"

# Stop existing
"$SCRIPT_DIR/stop-all.sh" 2>/dev/null || true

# Load .env (set -a auto-exports all vars so nohup child inherits them)
set -a
source "$ROOT/.env" 2>/dev/null || true
set +a

echo "Starting Claude Crew coordinator..."

nohup npx tsx "$ROOT/src/coordinator.ts" > "$LOG_DIR/coordinator.log" 2>&1 &

echo $! > "$PID_DIR/coordinator.pid"
echo "  PID: $!  Log: $LOG_DIR/coordinator.log"
echo ""
echo "Started. Commands:"
echo "  Logs:   tail -f $LOG_DIR/coordinator.log"
echo "  Stop:   $SCRIPT_DIR/stop-all.sh"
echo "  Status: $SCRIPT_DIR/status.sh"
