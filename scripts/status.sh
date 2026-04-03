#!/bin/bash
# Check status of Claude Crew coordinator

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PID_DIR="$ROOT/.pids"
LOG_DIR="$ROOT/logs"

source "$ROOT/.env" 2>/dev/null || true

echo "Claude Crew Status"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Coordinator process
pidfile="$PID_DIR/coordinator.pid"
if [ -f "$pidfile" ]; then
  pid=$(cat "$pidfile")
  if kill -0 "$pid" 2>/dev/null; then
    echo "  Coordinator: ✔ running (PID $pid)"
  else
    echo "  Coordinator: ✘ dead (stale PID $pid)"
  fi
else
  echo "  Coordinator: ✘ not started"
fi

# Check each bot's Telegram connectivity from agents.yaml
echo ""
echo "  Bots:"
current_name=""
current_token_env=""

while IFS= read -r line; do
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%% #*}"
  line="${line%"${line##*[![:space:]]}"}"
  case "$line" in
    "- name:"*)        current_name="${line#*: }" ;;
    "bot_token_env:"*)
      current_token_env="${line#*: }"
      local_token="${!current_token_env}"
      bot_status="✘ no token"
      if [ -n "$local_token" ]; then
        resp=$(curl -s --max-time 3 "https://api.telegram.org/bot${local_token}/getMe" 2>/dev/null)
        if echo "$resp" | grep -q '"ok":true'; then
          bot_status="✔ online"
        else
          bot_status="✘ unreachable"
        fi
      fi
      printf "    %-12s %s\n" "$current_name" "$bot_status"
      current_name="" current_token_env=""
      ;;
  esac
done < "$ROOT/agents.yaml"

echo ""
echo "  Log: $LOG_DIR/coordinator.log"
