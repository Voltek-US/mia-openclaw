#!/usr/bin/env bash
# Add a task to the queue.
# Usage: task-add.sh <type> <prompt> [priority] [scheduled_for] [schedule] [auto_resolve] [max_retries]
set -euo pipefail

DB="${MIA_DB:-$HOME/.openclaw/ledi/mia.sqlite}"

TYPE="${1:?Usage: task-add.sh <type> <prompt> [priority] [scheduled_for] [schedule] [auto_resolve] [max_retries]}"
PROMPT="${2:?Prompt is required}"
PRIORITY="${3:-5}"
SCHEDULED="${4:-$(date -u +"%Y-%m-%d %H:%M:%S")}"
SCHEDULE="${5:-}"
AUTO="${6:-0}"
MAX_RETRIES="${7:-5}"

# Escape single quotes for SQL
SAFE_PROMPT=$(echo "$PROMPT" | sed "s/'/''/g")

if [ -n "$SCHEDULE" ]; then
  SCHED_VAL="'$SCHEDULE'"
else
  SCHED_VAL="NULL"
fi

ID=$(sqlite3 "$DB" "INSERT INTO task_queue (task_type, prompt, priority, scheduled_for, schedule, auto_resolve, max_retries) VALUES ('$TYPE', '$SAFE_PROMPT', $PRIORITY, '$SCHEDULED', $SCHED_VAL, $AUTO, $MAX_RETRIES); SELECT last_insert_rowid();")

echo "{\"id\":$ID,\"type\":\"$TYPE\",\"prompt\":\"$PROMPT\",\"priority\":$PRIORITY}"
