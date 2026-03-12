#!/usr/bin/env bash
# Resolve an error (or all errors for a task).
# Usage: errors-resolve.sh <error_id | --task task_id | --all>
set -euo pipefail

DB="${MIA_DB:-$HOME/.openclaw/ledi/mia.sqlite}"

case "${1:-}" in
  --task)
    TID="${2:?Task ID required}"
    sqlite3 "$DB" "UPDATE errors SET resolved = 1 WHERE task_id = $TID;"
    echo "{\"resolved_for_task\":$TID}"
    ;;
  --all)
    sqlite3 "$DB" "UPDATE errors SET resolved = 1 WHERE resolved = 0;"
    echo "{\"resolved\":\"all\"}"
    ;;
  *)
    EID="${1:?Usage: errors-resolve.sh <error_id | --task task_id | --all>}"
    sqlite3 "$DB" "UPDATE errors SET resolved = 1 WHERE id = $EID;"
    echo "{\"resolved_error\":$EID}"
    ;;
esac
