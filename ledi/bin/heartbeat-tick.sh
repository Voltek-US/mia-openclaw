#!/usr/bin/env bash
# Heartbeat tick — run every 10 min via cron.
# 1. Auto-fail stale tasks (running > 30 min)
# 2. Pick up pending due tasks by priority
# 3. Surface unnotified errors
# 4. Reschedule recurring tasks that completed
#
# Output: JSON summary for the agent to act on (or "HEARTBEAT_OK" if nothing to do)
set -euo pipefail

DB="${MIA_DB:-$HOME/.openclaw/ledi/mia.sqlite}"
NOW=$(date -u +"%Y-%m-%d %H:%M:%S")

# ── 1. Auto-fail stale tasks ──────────────────────────────────
STALE=$(sqlite3 "$DB" <<SQL
UPDATE task_queue
SET    status = 'failed',
       error_type = 'stale',
       completed_at = '$NOW',
       updated_at = '$NOW'
WHERE  status = 'running'
AND    started_at < datetime('$NOW', '-30 minutes');
SELECT changes();
SQL
)

if [ "$STALE" -gt 0 ]; then
  # Log stale failures
  sqlite3 "$DB" <<SQL
INSERT INTO errors (task_id, error_type, error_message)
SELECT id, 'stale', 'Task stuck in running for >30 min, auto-failed'
FROM   task_queue
WHERE  status = 'failed' AND error_type = 'stale'
AND    completed_at = '$NOW';

INSERT INTO action_log (task_id, action, detail)
SELECT id, 'failed_stale', 'Auto-failed after 30 min timeout'
FROM   task_queue
WHERE  status = 'failed' AND error_type = 'stale'
AND    completed_at = '$NOW';
SQL
fi

# ── 2. Pick up pending due tasks ──────────────────────────────
PENDING=$(sqlite3 -json "$DB" <<SQL
SELECT id, task_type, prompt, priority, retry_count, max_retries, auto_resolve, schedule
FROM   task_queue
WHERE  status = 'pending'
AND    scheduled_for <= '$NOW'
ORDER BY priority DESC, scheduled_for ASC
LIMIT  10;
SQL
)

# ── 3. Unnotified errors ─────────────────────────────────────
UNNOTIFIED=$(sqlite3 -json "$DB" <<SQL
SELECT e.id AS error_id, e.task_id, e.error_type, e.error_message, t.prompt AS task_prompt
FROM   errors e
LEFT JOIN task_queue t ON t.id = e.task_id
WHERE  e.notified = 0 AND e.resolved = 0
ORDER BY e.created_at DESC
LIMIT  10;
SQL
)

# ── 4. Recurring tasks needing reschedule ─────────────────────
RECURRING=$(sqlite3 -json "$DB" <<SQL
SELECT id, task_type, prompt, priority, schedule
FROM   task_queue
WHERE  status = 'done'
AND    schedule IS NOT NULL
AND    schedule != ''
ORDER BY completed_at DESC
LIMIT  10;
SQL
)

# ── Build output ──────────────────────────────────────────────
HAS_WORK=0

OUTPUT="{"
OUTPUT+="\"stale_failed\":$STALE,"

if [ "$PENDING" != "[]" ] && [ -n "$PENDING" ]; then
  OUTPUT+="\"pending_tasks\":$PENDING,"
  HAS_WORK=1
else
  OUTPUT+="\"pending_tasks\":[],"
fi

if [ "$UNNOTIFIED" != "[]" ] && [ -n "$UNNOTIFIED" ]; then
  OUTPUT+="\"unnotified_errors\":$UNNOTIFIED,"
  HAS_WORK=1
else
  OUTPUT+="\"unnotified_errors\":[],"
fi

if [ "$RECURRING" != "[]" ] && [ -n "$RECURRING" ]; then
  OUTPUT+="\"recurring_to_reschedule\":$RECURRING,"
  HAS_WORK=1
else
  OUTPUT+="\"recurring_to_reschedule\":[],"
fi

OUTPUT+="\"timestamp\":\"$NOW\"}"

if [ "$HAS_WORK" -eq 0 ] && [ "$STALE" -eq 0 ]; then
  echo "HEARTBEAT_OK"
else
  echo "$OUTPUT"
fi
