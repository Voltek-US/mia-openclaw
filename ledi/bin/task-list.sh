#!/usr/bin/env bash
# List tasks, optionally filtered.
# Usage: task-list.sh [status] [type]
# Examples:
#   task-list.sh              → all non-done tasks
#   task-list.sh pending      → pending only
#   task-list.sh all          → everything
#   task-list.sh all shopping → all shopping tasks
set -euo pipefail

DB="${MIA_DB:-$HOME/.openclaw/ledi/mia.sqlite}"
STATUS="${1:-active}"
TYPE="${2:-}"

WHERE="WHERE 1=1"
if [ "$STATUS" = "active" ]; then
  WHERE="$WHERE AND status IN ('pending','running')"
elif [ "$STATUS" != "all" ]; then
  WHERE="$WHERE AND status = '$STATUS'"
fi

if [ -n "$TYPE" ]; then
  WHERE="$WHERE AND task_type = '$TYPE'"
fi

sqlite3 -json "$DB" <<SQL
SELECT id, task_type, prompt, status, priority, scheduled_for, retry_count, schedule, auto_resolve,
       CASE WHEN status='running' AND started_at < datetime('now', '-30 minutes') THEN 1 ELSE 0 END AS stale
FROM   task_queue
$WHERE
ORDER BY priority DESC, scheduled_for ASC;
SQL
