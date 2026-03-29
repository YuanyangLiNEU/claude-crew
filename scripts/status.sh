#!/bin/bash
# Check status of all Claude Crew agents

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PID_DIR="$ROOT/.pids"
LOG_DIR="$ROOT/logs"

source "$ROOT/.env" 2>/dev/null || true

echo "Claude Crew Status"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Parse agent IDs and names from agents.yaml
current_name=""
current_id=""
current_token_env=""

check_agent() {
  local name="$1" id="$2" token_env="$3"
  [ -z "$id" ] && return

  local pidfile="$PID_DIR/$id.pid"
  local proc_status="✘ not started"
  if [ -f "$pidfile" ]; then
    local pid=$(cat "$pidfile")
    if kill -0 "$pid" 2>/dev/null; then
      proc_status="✔ running (PID $pid)"
    else
      proc_status="✘ dead (stale PID $pid)"
    fi
  fi

  local bot_status=""
  local token="${!token_env}"
  if [ -n "$token" ]; then
    local resp=$(curl -s --max-time 3 "https://api.telegram.org/bot${token}/getMe" 2>/dev/null)
    if echo "$resp" | grep -q '"ok":true'; then
      bot_status="| bot ✔"
    else
      bot_status="| bot ✘"
    fi
  fi

  printf "  %-12s %-8s %s %s\n" "$id" "$name" "$proc_status" "$bot_status"
}

while IFS= read -r line; do
  line="${line#"${line%%[![:space:]]*}"}"
  case "$line" in
    "- name:"*)        current_name="${line#*: }" ;;
    "id:"*)            current_id="${line#*: }" ;;
    "bot_token_env:"*) current_token_env="${line#*: }" ;;
    "extra_disallowed:"*)
      check_agent "$current_name" "$current_id" "$current_token_env"
      current_name="" current_id="" current_token_env=""
      ;;
  esac
done < "$ROOT/agents.yaml"

echo ""
echo "Logs: $LOG_DIR/"
