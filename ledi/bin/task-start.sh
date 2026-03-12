#!/usr/bin/env bash
# Mark a task as running. Called at the start of execution.
# Usage: task-start.sh <task_id>
set -euo pipefail

DB="${MIA_DB:-$HOME/.openclaw/ledi/mia.sqlite}"
ID="${1:?Usage: task-start.sh <task_id>}"
NOW=$(date -u +"%Y-%m-%d %H:%M:%S")

sqlite3 "$DB" <<SQL
UPDATE task_queue
SET    status = 'running', started_at = '$NOW', updated_at = '$NOW'
WHERE  id = $ID AND status = 'pending';
SQL

echo "{\"id\":$ID,\"status\":\"running\"}"
