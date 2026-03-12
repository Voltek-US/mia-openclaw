#!/usr/bin/env bash
# Shopping list convenience wrapper.
# Usage:
#   shopping.sh add "Almond milk"         → add item
#   shopping.sh list                      → show pending items
#   shopping.sh bought <id>               → mark bought
#   shopping.sh clear                     → clear all bought items
set -euo pipefail

DB="${MIA_DB:-$HOME/.openclaw/ledi/mia.sqlite}"
BIN="$(dirname "$0")"

case "${1:-list}" in
  add)
    ITEM="${2:?Item name required}"
    "$BIN/task-add.sh" shopping "$ITEM" 5 "" "" 1
    ;;
  list)
    sqlite3 -json "$DB" <<SQL
SELECT id, prompt AS item, status, created_at
FROM   task_queue
WHERE  task_type = 'shopping' AND status IN ('pending','running')
ORDER BY created_at DESC;
SQL
    ;;
  bought)
    ID="${2:?Item ID required}"
    "$BIN/task-complete.sh" "$ID" "bought"
    ;;
  clear)
    NOW=$(date -u +"%Y-%m-%d %H:%M:%S")
    sqlite3 "$DB" <<SQL
INSERT INTO action_log (task_id, action, detail)
SELECT id, 'cleared', 'Auto-cleared bought shopping item'
FROM   task_queue WHERE task_type = 'shopping' AND status = 'done';

DELETE FROM task_queue WHERE task_type = 'shopping' AND status = 'done';
SQL
    echo "{\"action\":\"cleared_bought_items\"}"
    ;;
  *)
    echo "Usage: shopping.sh {add|list|bought|clear}"
    exit 1
    ;;
esac
