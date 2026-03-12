#!/usr/bin/env bash
# Initialize / migrate mia.sqlite schema
set -euo pipefail

DB="${MIA_DB:-$HOME/.openclaw/ledi/mia.sqlite}"

sqlite3 "$DB" <<'SQL'
-- Core task queue
CREATE TABLE IF NOT EXISTS task_queue (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    task_type           TEXT NOT NULL,
    prompt              TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK(status IN ('pending','running','done','failed','cancelled')),
    priority            INTEGER NOT NULL DEFAULT 5,
    scheduled_for       DATETIME NOT NULL DEFAULT (datetime('now')),
    started_at          DATETIME,
    completed_at        DATETIME,
    output              TEXT,
    error_type          TEXT,
    retry_count         INTEGER NOT NULL DEFAULT 0,
    max_retries         INTEGER NOT NULL DEFAULT 5,
    retry_delay_seconds INTEGER NOT NULL DEFAULT 60,
    schedule            TEXT,
    auto_resolve        INTEGER NOT NULL DEFAULT 0,
    created_at          DATETIME NOT NULL DEFAULT (datetime('now'))
);

-- Error log (add delivery to allowed types via re-create if needed)
CREATE TABLE IF NOT EXISTS errors (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id       INTEGER REFERENCES task_queue(id),
    error_type    TEXT NOT NULL,
    error_message TEXT,
    resolved      INTEGER NOT NULL DEFAULT 0,
    notified      INTEGER NOT NULL DEFAULT 0,
    created_at    DATETIME NOT NULL DEFAULT (datetime('now'))
);

-- Action log for household autonomy audit trail
CREATE TABLE IF NOT EXISTS action_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    INTEGER REFERENCES task_queue(id),
    action     TEXT NOT NULL,
    detail     TEXT,
    created_at DATETIME NOT NULL DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_tq_status        ON task_queue(status);
CREATE INDEX IF NOT EXISTS idx_tq_scheduled_for ON task_queue(scheduled_for);
CREATE INDEX IF NOT EXISTS idx_tq_priority      ON task_queue(priority);
CREATE INDEX IF NOT EXISTS idx_tq_type          ON task_queue(task_type);
CREATE INDEX IF NOT EXISTS idx_err_task_id      ON errors(task_id);
CREATE INDEX IF NOT EXISTS idx_err_notified     ON errors(notified);
CREATE INDEX IF NOT EXISTS idx_err_resolved     ON errors(resolved);
CREATE INDEX IF NOT EXISTS idx_al_task_id       ON action_log(task_id);
SQL

# Safe column additions (ignore "duplicate column" errors)
sqlite3 "$DB" "ALTER TABLE task_queue ADD COLUMN updated_at DATETIME;" 2>/dev/null || true

echo "mia.sqlite schema OK → $DB"
