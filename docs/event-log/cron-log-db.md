---
title: "Cron Log Database"
summary: "Central SQLite log for cron job runs: start/end recording, idempotency checks, stale detection, and failure alerting."
---

# Cron Log Database (`scripts/cron-log-db.ts`)

`cron-log-db.ts` provides a lightweight SQLite database that tracks every cron job execution. Unlike the per-job JSONL run logs (written by the OpenClaw cron engine after a job finishes), this database records a **start entry before the job runs** — enabling stale detection, PID tracking, idempotency checks, and cross-job failure analysis.

```
~/.openclaw/cron-log.db   ← default location
```

---

## Quick Start

```bash
# Record a job start; save the returned run ID
RUN_ID=$(bun scripts/cron-log-db.ts log-start my-job --pid $$ | jq -r .runId)

# … run the job …

# Record completion
bun scripts/cron-log-db.ts log-end "$RUN_ID" ok --summary "processed 42 rows"
```

In practice, use `cron-wrap.sh` instead — it calls these two commands automatically around the wrapped command and also manages the PID lockfile.

---

## DB Location

| Source                         | Value                               |
| ------------------------------ | ----------------------------------- |
| Default                        | `~/.openclaw/cron-log.db`           |
| `--db <path>` flag             | Override per call                   |
| `OPENCLAW_CRON_LOG_DB` env var | Override for all calls in the shell |

The directory is created automatically on first run.

---

## Schema

```sql
CREATE TABLE cron_runs (
  run_id      TEXT    PRIMARY KEY,   -- UUID v4
  job_name    TEXT    NOT NULL,
  started_at  INTEGER NOT NULL,      -- ms since epoch
  finished_at INTEGER,               -- NULL while running
  status      TEXT    DEFAULT 'running',
  duration_ms INTEGER,
  summary     TEXT,
  error       TEXT,
  pid         INTEGER
);
```

**Status values**: `running` · `ok` · `error` · `skipped` · `interrupted` · `timeout`

WAL journal mode is enabled automatically for concurrent read/write safety.

---

## Actions

### `log-start`

Record the start of a job run. Automatically calls `cleanup-stale` before inserting, so stuck runs from a previous crash are resolved first.

```bash
bun scripts/cron-log-db.ts log-start <job-name> [--pid <n>]
```

Output:

```json
{ "runId": "550e8400-e29b-41d4-a716-446655440000" }
```

| Option       | Description                                                    |
| ------------ | -------------------------------------------------------------- |
| `<job-name>` | Required. Unique name for the job.                             |
| `--pid <n>`  | Optional. PID of the running process (stored for diagnostics). |

---

### `log-end`

Record the completion of a run.

```bash
bun scripts/cron-log-db.ts log-end <run-id> <status> [--summary <s>] [--error <e>]
```

Output:

```json
{ "ok": true }
```

| Argument        | Description                                            |
| --------------- | ------------------------------------------------------ |
| `<run-id>`      | The `runId` returned by `log-start`.                   |
| `<status>`      | One of: `ok` `error` `skipped` `interrupted` `timeout` |
| `--summary <s>` | Optional. Short human-readable result.                 |
| `--error <e>`   | Optional. Error message (for non-ok statuses).         |

---

### `query`

Filter and list run history. Results are sorted newest-first.

```bash
bun scripts/cron-log-db.ts query [options]
```

| Option         | Description                                                    |
| -------------- | -------------------------------------------------------------- |
| `--job <name>` | Filter by job name.                                            |
| `--status <s>` | Filter by status (`running`, `ok`, `error`, …).                |
| `--from <iso>` | Earliest `started_at` (ISO 8601, e.g. `2026-03-01T00:00:00Z`). |
| `--to <iso>`   | Latest `started_at`.                                           |
| `--limit <n>`  | Max rows to return (default 50, max 1000).                     |

Output: JSON array of `cron_runs` rows.

**Examples**:

```bash
# All runs in the last day
bun scripts/cron-log-db.ts query --from "$(date -d '1 day ago' -Iseconds)"

# Recent errors for a specific job
bun scripts/cron-log-db.ts query --job event-log-ingest --status error --limit 10

# Currently running jobs (possible stuck runs)
bun scripts/cron-log-db.ts query --status running
```

---

### `should-run`

Idempotency guard: check whether a job has already succeeded in the current window.

```bash
bun scripts/cron-log-db.ts should-run <job-name> --window today|this-hour
```

| Exit code | Meaning                            |
| --------- | ---------------------------------- |
| `0`       | No successful run found — proceed. |
| `1`       | Already succeeded — skip.          |

Output:

```json
{ "shouldRun": false, "reason": "already succeeded this today" }
```

**Windows**:

- `today` — since midnight local time
- `this-hour` — since the start of the current hour

**Example** (shell):

```bash
if bun scripts/cron-log-db.ts should-run my-job --window today; then
  bash scripts/cron-wrap.sh --job my-job -- bun scripts/my-job.ts
fi
```

---

### `cleanup-stale`

Mark any run that has been in `running` status for longer than the max age as `error`.

```bash
bun scripts/cron-log-db.ts cleanup-stale [--max-age-hours <n>]
```

| Option                | Default |
| --------------------- | ------- |
| `--max-age-hours <n>` | `2`     |

Output:

```json
{ "cleaned": 3 }
```

`log-start` calls this automatically, so manual invocation is rarely needed. The health-check job also calls it every 30 minutes as a belt-and-suspenders measure.

---

### `check-failures`

Report jobs that have failed repeatedly within a rolling window.

```bash
bun scripts/cron-log-db.ts check-failures [--window-hours <n>] [--threshold <n>]
```

| Option               | Default |
| -------------------- | ------- |
| `--window-hours <n>` | `6`     |
| `--threshold <n>`    | `3`     |

Output:

```json
{
  "failures": [
    {
      "job": "event-log-ingest",
      "count": 4,
      "lastError": "ENOENT: data/logs not found",
      "lastStartedAt": 1741392000000,
      "lastStartedAtIso": "2026-03-08T02:00:00.000Z"
    }
  ],
  "hasAlert": true
}
```

The `cron-health-check` scheduled job calls this every 30 minutes and sends an alert when `hasAlert` is `true`.

---

## Manual Diagnostics

```bash
# What ran today?
bun scripts/cron-log-db.ts query --from "$(date -Idate)"

# Any jobs currently stuck in "running"?
bun scripts/cron-log-db.ts query --status running

# Force-clean stuck runs (if the health check hasn't fired yet)
bun scripts/cron-log-db.ts cleanup-stale --max-age-hours 1

# Check for failure bursts
bun scripts/cron-log-db.ts check-failures --window-hours 12 --threshold 2
```

---

## Relationship to the OpenClaw Run Log

The OpenClaw cron engine writes its own per-job JSONL run logs under `~/.openclaw/cron-store/runs/<job-id>.jsonl`. Those logs record finished events with agent telemetry (model, token usage, delivery status).

`cron-log.db` is complementary — it records **start events** (enabling stale detection) and is designed for shell-wrapped jobs, whereas the JSONL logs are written automatically by the gateway for `agentTurn` jobs.

Use both together for full coverage.
