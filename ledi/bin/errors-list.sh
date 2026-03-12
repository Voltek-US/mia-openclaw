#!/usr/bin/env bash
# List unresolved errors, optionally mark as notified.
# Usage: errors-list.sh [--mark-notified]
set -euo pipefail

DB="${MIA_DB:-$HOME/.openclaw/ledi/mia.sqlite}"

sqlite3 -json "$DB" <<SQL
SELECT e.id AS error_id, e.task_id, e.error_type, e.error_message, e.created_at,
       t.task_type, t.prompt AS task_prompt
FROM   errors e
LEFT JOIN task_queue t ON t.id = e.task_id
WHERE  e.resolved = 0
ORDER BY e.created_at DESC
LIMIT 20;
SQL

if [ "${1:-}" = "--mark-notified" ]; then
  sqlite3 "$DB" "UPDATE errors SET notified = 1 WHERE resolved = 0 AND notified = 0;"
  echo ""
  echo "{\"marked_notified\":true}"
fi
