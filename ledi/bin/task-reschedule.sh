#!/usr/bin/env bash
# Reschedule a completed recurring task based on its cron schedule.
# Usage: task-reschedule.sh <task_id>
set -euo pipefail

DB="${MIA_DB:-$HOME/.openclaw/ledi/mia.sqlite}"
ID="${1:?Usage: task-reschedule.sh <task_id>}"

# Read the completed task
ROW=$(sqlite3 -separator '|' "$DB" \
  "SELECT task_type, prompt, priority, schedule, auto_resolve, max_retries FROM task_queue WHERE id=$ID AND schedule IS NOT NULL;")

if [ -z "$ROW" ]; then
  echo '{"error":"Task not found or has no recurring schedule"}'
  exit 1
fi

IFS='|' read -r TTYPE PROMPT PRIO SCHED AUTO MAXR <<< "$ROW"

# Calculate next run
NEXT=$(python3 -c "
from datetime import datetime, timedelta
parts = '$SCHED'.split()
if len(parts) == 5:
    minute, hour, dom, mon, dow = parts
    now = datetime.utcnow()
    target = now.replace(hour=int(hour), minute=int(minute), second=0, microsecond=0)
    if dow != '*':
        days_ahead = int(dow) - now.weekday()
        if days_ahead <= 0:
            days_ahead += 7
        target = now + timedelta(days=days_ahead)
        target = target.replace(hour=int(hour), minute=int(minute), second=0, microsecond=0)
    elif target <= now:
        target += timedelta(days=1)
    print(target.strftime('%Y-%m-%d %H:%M:%S'))
else:
    print((datetime.utcnow() + timedelta(days=1)).strftime('%Y-%m-%d %H:%M:%S'))
" 2>/dev/null || date -u -v+1d +"%Y-%m-%d %H:%M:%S")

SAFE_PROMPT=$(echo "$PROMPT" | sed "s/'/''/g")

NEW_ID=$(sqlite3 "$DB" "INSERT INTO task_queue (task_type, prompt, priority, scheduled_for, schedule, auto_resolve, max_retries) VALUES ('$TTYPE', '$SAFE_PROMPT', $PRIO, '$NEXT', '$SCHED', $AUTO, $MAXR); SELECT last_insert_rowid();")

sqlite3 "$DB" "INSERT INTO action_log (task_id, action, detail) VALUES ($ID, 'rescheduled', 'New task $NEW_ID scheduled for $NEXT');"

echo "{\"old_id\":$ID,\"new_id\":$NEW_ID,\"next_run\":\"$NEXT\"}"
