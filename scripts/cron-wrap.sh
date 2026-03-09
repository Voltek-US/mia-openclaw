#!/usr/bin/env bash
# cron-wrap.sh — Cron job wrapper with PID lockfile, signal traps, and cron log DB integration
#
# Usage:
#   scripts/cron-wrap.sh --job <name> [--timeout <seconds>] [--db <path>] -- <command> [args...]
#
# Options:
#   --job <name>         Required. Job name (alphanumeric, hyphens, underscores only).
#   --timeout <seconds>  Optional. Kill command after this many seconds (exit 124).
#   --db <path>          Optional. cron-log.db path. Also: OPENCLAW_CRON_LOG_DB env var.
#
# PID lock: ~/.openclaw/cron-locks/<job-name>.pid
#   If a lock exists and the stored PID is still alive → skip (exit 0, not an error).
#   If a lock exists but the PID is dead → remove stale lock and proceed.
#
# Exit codes:
#   0   — command succeeded (or skipped because already running)
#   1   — command failed
#   124 — command timed out (matches `timeout` utility convention)
#   130 — wrapper was interrupted by signal

set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
JOB=""
TIMEOUT_SECS=""
DB_ARG=""
COMMAND=()

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --job)
      JOB="$2"
      shift 2
      ;;
    --timeout)
      TIMEOUT_SECS="$2"
      shift 2
      ;;
    --db)
      DB_ARG="$2"
      shift 2
      ;;
    --)
      shift
      COMMAND=("$@")
      break
      ;;
    *)
      echo "[cron-wrap] Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Validate
# ---------------------------------------------------------------------------
if [[ -z "$JOB" ]]; then
  echo "[cron-wrap] --job <name> is required" >&2
  exit 1
fi

if [[ ! "$JOB" =~ ^[a-zA-Z0-9_-]+$ ]]; then
  echo "[cron-wrap] --job name must match [a-zA-Z0-9_-]+" >&2
  exit 1
fi

if [[ ${#COMMAND[@]} -eq 0 ]]; then
  echo "[cron-wrap] command is required after --" >&2
  exit 1
fi

# Resolve script dir so we can call cron-log-db.ts relative to repo root.
# Supports symlinks.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"

# cron-log-db.ts invocation (bun preferred; fallback to node tsx)
if command -v bun &>/dev/null; then
  CRON_DB_CMD=(bun "$SCRIPT_DIR/cron-log-db.ts")
else
  CRON_DB_CMD=(node --import tsx/esm "$SCRIPT_DIR/cron-log-db.ts")
fi

# Propagate --db / env var
if [[ -n "$DB_ARG" ]]; then
  CRON_DB_CMD+=(--db "$DB_ARG")
elif [[ -n "${OPENCLAW_CRON_LOG_DB:-}" ]]; then
  CRON_DB_CMD+=(--db "$OPENCLAW_CRON_LOG_DB")
fi

# ---------------------------------------------------------------------------
# PID lock
# ---------------------------------------------------------------------------
LOCK_DIR="${HOME}/.openclaw/cron-locks"
mkdir -p "$LOCK_DIR"
LOCK_FILE="$LOCK_DIR/${JOB}.pid"

if [[ -f "$LOCK_FILE" ]]; then
  STORED_PID="$(cat "$LOCK_FILE" 2>/dev/null || true)"
  if [[ -n "$STORED_PID" ]] && kill -0 "$STORED_PID" 2>/dev/null; then
    echo "[cron-wrap] $JOB already running (PID $STORED_PID); skipping" >&2
    exit 0
  else
    echo "[cron-wrap] $JOB: removing stale lock (PID $STORED_PID)" >&2
    rm -f "$LOCK_FILE"
  fi
fi

# ---------------------------------------------------------------------------
# log-start
# ---------------------------------------------------------------------------
LOG_START_OUT="$("${CRON_DB_CMD[@]}" log-start "$JOB" --pid "$$" 2>/dev/null || true)"
RUN_ID="$(echo "$LOG_START_OUT" | grep -o '"runId":"[^"]*"' | cut -d'"' -f4 || true)"

if [[ -z "$RUN_ID" ]]; then
  echo "[cron-wrap] $JOB: failed to obtain run ID from cron-log-db; continuing without logging" >&2
fi

# Write PID file
echo "$$" > "$LOCK_FILE"

# ---------------------------------------------------------------------------
# Cleanup function (called on exit and signals)
# ---------------------------------------------------------------------------
CHILD_PID=""
EXIT_STATUS=0

cleanup() {
  local sig="${1:-}"
  local status="${2:-error}"

  # Kill the child process group if still running
  if [[ -n "$CHILD_PID" ]] && kill -0 "$CHILD_PID" 2>/dev/null; then
    kill -TERM "-$CHILD_PID" 2>/dev/null || kill -TERM "$CHILD_PID" 2>/dev/null || true
    sleep 1
    kill -KILL "-$CHILD_PID" 2>/dev/null || kill -KILL "$CHILD_PID" 2>/dev/null || true
  fi

  # Remove PID file
  rm -f "$LOCK_FILE"

  # log-end
  if [[ -n "$RUN_ID" ]]; then
    if [[ "$sig" == "signal" ]]; then
      "${CRON_DB_CMD[@]}" log-end "$RUN_ID" interrupted \
        --error "interrupted by signal" >/dev/null 2>&1 || true
    elif [[ "$status" == "timeout" ]]; then
      "${CRON_DB_CMD[@]}" log-end "$RUN_ID" timeout \
        --error "timed out after ${TIMEOUT_SECS}s" >/dev/null 2>&1 || true
    elif [[ "$status" == "ok" ]]; then
      "${CRON_DB_CMD[@]}" log-end "$RUN_ID" ok >/dev/null 2>&1 || true
    else
      "${CRON_DB_CMD[@]}" log-end "$RUN_ID" error \
        --error "exit code $EXIT_STATUS" >/dev/null 2>&1 || true
    fi
  fi
}

# Signal traps — clean up and exit 130 (interrupted)
trap 'cleanup signal; exit 130' SIGTERM SIGINT SIGHUP

# ---------------------------------------------------------------------------
# Run the command
# ---------------------------------------------------------------------------
cd "$REPO_ROOT"

if [[ -n "$TIMEOUT_SECS" ]]; then
  # Use a subshell so we can set a new process group for the child
  set +e
  (
    # Create new process group so we can kill the whole tree
    set -m
    timeout "$TIMEOUT_SECS" "${COMMAND[@]}" &
    CHILD_PID=$!
    wait "$CHILD_PID"
  )
  EXIT_STATUS=$?
  set -e
else
  set +e
  setsid "${COMMAND[@]}" &
  CHILD_PID=$!
  wait "$CHILD_PID"
  EXIT_STATUS=$?
  set -e
fi

# ---------------------------------------------------------------------------
# Record outcome
# ---------------------------------------------------------------------------
if [[ $EXIT_STATUS -eq 0 ]]; then
  cleanup "" ok
elif [[ $EXIT_STATUS -eq 124 ]]; then
  # timeout(1) exits 124 on timeout
  cleanup "" timeout
  rm -f "$LOCK_FILE"
  exit 124
else
  cleanup "" error
fi

rm -f "$LOCK_FILE"
exit $EXIT_STATUS
