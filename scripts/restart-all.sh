#!/bin/bash
# (Re)start all Claude Crew agents in background
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
LOG_DIR="$ROOT/logs"
PID_DIR="$ROOT/.pids"

mkdir -p "$LOG_DIR" "$PID_DIR"

# Stop existing agents
"$SCRIPT_DIR/stop-all.sh" 2>/dev/null || true

# Load .env
source "$ROOT/.env" 2>/dev/null || true

# First agent in agents.yaml becomes the router (handles message routing)
ROUTER_AGENT=""

# Parse agents.yaml and start each agent
current_name=""
current_id=""
current_dir=""
current_token_env=""
current_extra=""
current_model=""

start_agent() {
  local name="$1" id="$2" dir="$3" token_env="$4" extra="$5" model="$6"
  [ -z "$name" ] && return

  local token="${!token_env}"
  if [ -z "$token" ]; then
    echo "  SKIP $name — $token_env not set in .env"
    return
  fi

  # First agent that actually starts becomes the router
  if [ -z "$ROUTER_AGENT" ]; then
    ROUTER_AGENT="$id"
    echo "Router: $name ($id)"
  fi

  local agent_dir="$ROOT/$dir"
  echo "Starting $name ($id)..."

  TELEGRAM_BOT_TOKEN="$token" \
  ALLOWED_USERS="${ALLOWED_USERS:-}" \
  AGENT_NAME="$name" \
  AGENT_ID="$id" \
  AGENT_DIR="$agent_dir" \
  AGENT_MODEL="${model:-sonnet}" \
  EXTRA_DISALLOWED_TOOLS="$extra" \
  ROUTER_AGENT="${ROUTER_AGENT:-}" \
  CONFIG_PATH="$ROOT/agents.yaml" \
  nohup npx tsx "$ROOT/src/index.ts" > "$LOG_DIR/$id.log" 2>&1 &

  echo $! > "$PID_DIR/$id.pid"
  echo "  PID: $!  Log: $LOG_DIR/$id.log"
}

# Parse agents.yaml
while IFS= read -r line; do
  # Trim whitespace
  line="${line#"${line%%[![:space:]]*}"}"

  # Strip inline comments (everything after " #") and trailing whitespace
  line="${line%% #*}"
  line="${line%"${line##*[![:space:]]}"}"

  case "$line" in
    "- name:"*)    current_name="${line#*: }" ;;
    "id:"*)        current_id="${line#*: }" ;;
    "dir:"*)       current_dir="${line#*: }" ;;
    "bot_token_env:"*) current_token_env="${line#*: }" ;;
    "model:"*)
      current_model="${line#*: }"
      current_model="${current_model#\"}"
      current_model="${current_model%\"}"
      ;;
    "extra_disallowed:"*)
      current_extra="${line#*: }"
      current_extra="${current_extra#\"}"
      current_extra="${current_extra%\"}"
      # This is the last field per agent — start it
      start_agent "$current_name" "$current_id" "$current_dir" "$current_token_env" "$current_extra" "$current_model"
      current_name="" current_id="" current_dir="" current_token_env="" current_extra="" current_model=""
      ;;
  esac
done < "$ROOT/agents.yaml"

echo ""
echo "All agents started."
echo "  Logs:   tail -f $LOG_DIR/*.log"
echo "  Stop:   $SCRIPT_DIR/stop-all.sh"
echo "  Status: $SCRIPT_DIR/status.sh"
