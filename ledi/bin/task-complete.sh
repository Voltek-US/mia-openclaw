#!/usr/bin/env bash
# Mark a task as done.
# Usage: task-complete.sh <task_id> [output]
set -euo pipefail

DB="${MIA_DB:-$HOME/.openclaw/ledi/mia.sqlite}"
ID="${1:?Usage: task-complete.sh <task_id> [output]}"
OUTPUT="${2:-}"
NOW=$(date -u +"%Y-%m-%d %H:%M:%S")

sqlite3 "$DB" <<SQL
UPDATE task_queue
SET    status = 'done',
       completed_at = '$NOW',
       updated_at = '$NOW',
       output = '$(echo "$OUTPUT" | sed "s/'/''/g")'
WHERE  id = $ID AND status IN ('running', 'pending');
SQL

sqlite3 "$DB" <<SQL
INSERT INTO action_log (task_id, action, detail)
VALUES ($ID, 'completed', '$(echo "$OUTPUT" | sed "s/'/''/g")');
SQL

echo "{\"id\":$ID,\"status\":\"done\"}"
