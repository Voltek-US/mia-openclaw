#!/usr/bin/env bash
# Record a task failure with error classification and exponential backoff retry.
# Usage: task-fail.sh <task_id> <error_type> [error_message]
# error_type: rate_limit | network | auth | data | delivery | unknown
set -euo pipefail

DB="${MIA_DB:-$HOME/.openclaw/ledi/mia.sqlite}"
ID="${1:?Usage: task-fail.sh <task_id> <error_type> [error_message]}"
ERR_TYPE="${2:?Error type required: rate_limit|network|auth|data|delivery|unknown}"
ERR_MSG="${3:-}"
NOW=$(date -u +"%Y-%m-%d %H:%M:%S")

# Get current retry state
IFS='|' read -r RETRY_COUNT MAX_RETRIES RETRY_DELAY <<< "$(sqlite3 -separator '|' "$DB" \
  "SELECT retry_count, max_retries, retry_delay_seconds FROM task_queue WHERE id=$ID;")"

NEW_RETRY=$((RETRY_COUNT + 1))

# Log the error
sqlite3 "$DB" <<SQL
INSERT INTO errors (task_id, error_type, error_message)
VALUES ($ID, '$ERR_TYPE', '$(echo "$ERR_MSG" | sed "s/'/''/g")');
SQL

if [ "$NEW_RETRY" -le "$MAX_RETRIES" ] && [ "$ERR_TYPE" != "auth" ]; then
  # Exponential backoff: delay * 2^retry_count
  BACKOFF_SECS=$(( RETRY_DELAY * (1 << RETRY_COUNT) ))
  sqlite3 "$DB" <<SQL
UPDATE task_queue
SET    status = 'pending',
       retry_count = $NEW_RETRY,
       error_type = '$ERR_TYPE',
       scheduled_for = datetime('$NOW', '+$BACKOFF_SECS seconds'),
       updated_at = '$NOW'
WHERE  id = $ID;
SQL

  sqlite3 "$DB" <<SQL
INSERT INTO action_log (task_id, action, detail)
VALUES ($ID, 'retried', 'Retry $NEW_RETRY/$MAX_RETRIES, backoff ${BACKOFF_SECS}s, error: $ERR_TYPE');
SQL

  echo "{\"id\":$ID,\"action\":\"retry\",\"attempt\":$NEW_RETRY,\"backoff_seconds\":$BACKOFF_SECS}"
else
  # Max retries exhausted or auth error → fail permanently, notify
  sqlite3 "$DB" <<SQL
UPDATE task_queue
SET    status = 'failed',
       retry_count = $NEW_RETRY,
       error_type = '$ERR_TYPE',
       completed_at = '$NOW',
       updated_at = '$NOW'
WHERE  id = $ID;

UPDATE errors SET notified = 0
WHERE  task_id = $ID AND id = (SELECT MAX(id) FROM errors WHERE task_id = $ID);
SQL

  sqlite3 "$DB" <<SQL
INSERT INTO action_log (task_id, action, detail)
VALUES ($ID, 'failed_permanent', 'Max retries exhausted or auth error: $ERR_TYPE - $(echo "$ERR_MSG" | sed "s/'/''/g")');
SQL

  echo "{\"id\":$ID,\"action\":\"failed_permanent\",\"error_type\":\"$ERR_TYPE\",\"notify\":true}"
fi
