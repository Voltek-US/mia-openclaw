---
title: "Database Ingest — log-ingest.ts"
summary: "Reference for log-ingest.ts: parse JSONL event logs and raw gateway logs into SQLite, with deduplication for safe re-runs on overlapping rotated files."
---

# Database Ingest (`log-ingest.ts`)

`scripts/log-ingest.ts` reads the JSONL event-log files and raw gateway log files and inserts the parsed rows into a SQLite database. It is designed to be run as a **nightly cron job**.

## Usage

```bash
bun scripts/log-ingest.ts [options]
# or
node --import tsx/esm scripts/log-ingest.ts [options]
```

## Options

| Flag               | Default                                        | Description                                          |
| ------------------ | ---------------------------------------------- | ---------------------------------------------------- |
| `--log-dir <path>` | `data/logs`                                    | Directory containing `*.jsonl` event-log files       |
| `--raw-dir <path>` | `$OPENCLAW_LOG_DIR` or system temp `openclaw/` | Directory containing raw gateway `.log` files        |
| `--db <path>`      | `<log-dir>/structured.db`                      | Output SQLite database path                          |
| `--dry-run`        | off                                            | Parse and count rows without writing to the database |
| `--verbose`        | off                                            | Print per-file progress to stderr                    |
| `-h`, `--help`     | —                                              | Print help and exit                                  |

## Database Schema

### `structured_logs` — event-log entries

Created from `*.jsonl` files in the log directory.

| Column        | Type        | Notes                                               |
| ------------- | ----------- | --------------------------------------------------- |
| `id`          | INTEGER PK  | Auto-increment                                      |
| `row_hash`    | TEXT UNIQUE | FNV-1a hash of the raw line; used for deduplication |
| `source_file` | TEXT        | Absolute path of the source `.jsonl` file           |
| `time`        | TEXT        | ISO-8601 timestamp from the entry                   |
| `event`       | TEXT        | Event name (e.g. `api.request`)                     |
| `level`       | TEXT        | Log level (`info`, `warn`, etc.)                    |
| `message`     | TEXT        | Human-readable message                              |
| `extra_json`  | TEXT        | Remaining fields serialised as a JSON object        |

Indexes: `time`, `event`, `level`.

### `server_logs` — raw gateway log entries

Created from `openclaw-YYYY-MM-DD.log` files (the existing gateway file logger output).

| Column        | Type        | Notes                                       |
| ------------- | ----------- | ------------------------------------------- |
| `id`          | INTEGER PK  | Auto-increment                              |
| `row_hash`    | TEXT UNIQUE | Deduplication hash                          |
| `source_file` | TEXT        | Absolute path of the source `.log` file     |
| `time`        | TEXT        | Parsed from the JSON `time` field           |
| `level`       | TEXT        | Parsed from `level` or `_meta.logLevelName` |
| `subsystem`   | TEXT        | Parsed from `subsystem` or `module` field   |
| `message`     | TEXT        | Parsed from `message` or `msg` field        |
| `raw_line`    | TEXT        | Full original log line verbatim             |

Indexes: `time`, `level`, `subsystem`.

## Deduplication

Both tables use `INSERT OR IGNORE` keyed on `row_hash`. The hash is a fast FNV-1a fingerprint of the raw text line.

This means:

- Running the script **multiple times on the same files** is safe — no duplicate rows.
- Running after a **log rotation** where new and old files overlap is safe.
- `all.jsonl` can be ingested together with per-event files without creating duplicates (both write identical lines, so hashes match).

## Output

The script always prints a single JSON summary line to stdout:

```json
{
  "dryRun": false,
  "structured": { "parsed": 6, "inserted": 3 },
  "server": { "parsed": 8, "inserted": 8 }
}
```

- `parsed` — lines read from all files
- `inserted` — rows actually written (`0` on a re-run = all already present)

## Examples

### Basic run (writes to `data/logs/structured.db`)

```bash
bun scripts/log-ingest.ts
```

### Verbose to see per-file progress

```bash
bun scripts/log-ingest.ts --verbose
```

```
[log-ingest] logDir  = /home/user/openclaw/data/logs
[log-ingest] rawDir  = /tmp/openclaw
[log-ingest] db      = /home/user/openclaw/data/logs/structured.db
[log-ingest] dry-run = false
[log-ingest] Found 2 per-event JSONL files
[log-ingest]   api.request.jsonl: parsed=120 inserted=120
[log-ingest]   auth.login.jsonl: parsed=14 inserted=14
[log-ingest] Ingesting all.jsonl
[log-ingest]   all.jsonl: parsed=134 inserted=0
[log-ingest] Found 3 raw server log files
[log-ingest]   openclaw-2026-03-06.log: parsed=4821 inserted=0
[log-ingest]   openclaw-2026-03-07.log: parsed=6102 inserted=6102
[log-ingest]   openclaw-2026-03-08.log: parsed=1244 inserted=1244
```

### Dry run to preview without writing

```bash
bun scripts/log-ingest.ts --dry-run --verbose
```

### Custom paths

```bash
bun scripts/log-ingest.ts \
  --log-dir /var/log/openclaw/events \
  --raw-dir /var/log/openclaw/gateway \
  --db /var/db/openclaw/structured.db
```

## Querying the Database

After ingest you can query with any SQLite tool:

```bash
sqlite3 data/logs/structured.db
```

```sql
-- Most common events today
SELECT event, count(*) AS n
FROM structured_logs
WHERE date(time) = date('now')
GROUP BY event
ORDER BY n DESC;

-- Errors in the last hour
SELECT time, event, message, extra_json
FROM structured_logs
WHERE level IN ('error','fatal')
  AND time >= datetime('now', '-1 hour')
ORDER BY time DESC;

-- Gateway warnings by subsystem
SELECT subsystem, count(*) AS n
FROM server_logs
WHERE level = 'warn'
  AND date(time) = date('now')
GROUP BY subsystem
ORDER BY n DESC;
```

## Environment Variables

| Variable                 | Description                                                   |
| ------------------------ | ------------------------------------------------------------- |
| `OPENCLAW_EVENT_LOG_DIR` | Default event-log directory (overridden by `--log-dir`)       |
| `OPENCLAW_LOG_DIR`       | Default raw gateway log directory (overridden by `--raw-dir`) |

## SQLite Runtime

The script uses **`bun:sqlite`** when running under Bun, and falls back to **`node:sqlite`** (Node 22.5+ experimental built-in) when running under Node. No additional npm package is required.
