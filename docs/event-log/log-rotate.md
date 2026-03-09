---
title: "Log Rotation — log-rotate.ts"
summary: "Reference for log-rotate.ts: size-based JSONL rotation with gzip archiving, configurable retention, and optional monthly SQLite archiving."
---

# Log Rotation (`log-rotate.ts`)

`scripts/log-rotate.ts` is a daily maintenance script that keeps log files from growing without bound. It performs two tasks:

1. **JSONL rotation** — compress and archive any `.jsonl` file that has exceeded a size threshold, then truncate the original so new events are written to a fresh file.
2. **Monthly DB archiving** _(optional)_ — move rows from past calendar months out of the main `structured.db` into separate per-month archive databases.

## Usage

```bash
bun scripts/log-rotate.ts [options]
# or
node --import tsx/esm scripts/log-rotate.ts [options]
```

## Options

| Flag                  | Default               | Description                                                           |
| --------------------- | --------------------- | --------------------------------------------------------------------- |
| `--dir <path>`        | `data/logs`           | Log directory containing `*.jsonl` files                              |
| `--threshold <bytes>` | `52428800` (50 MB)    | Rotate files larger than this many bytes                              |
| `--keep <n>`          | `3`                   | Number of compressed archives to retain per event name (0 = keep all) |
| `--archive-db`        | off                   | Also archive old SQLite rows into monthly databases                   |
| `--db <path>`         | `<dir>/structured.db` | Main structured database (used with `--archive-db`)                   |
| `--dry-run`           | off                   | Print what would happen without making any changes                    |
| `--verbose`           | off                   | Print progress to stderr                                              |
| `-h`, `--help`        | —                     | Print help and exit                                                   |

## JSONL Rotation

For each `*.jsonl` file whose size exceeds `--threshold`:

1. The current file is **read into memory and gzip-compressed** (level 6).
2. The compressed data is written to `<event-name>.<YYYY-MM-DD>.jsonl.gz` in the same directory. If an archive for today already exists a numeric suffix is appended (`.2`, `.3`, …).
3. The original `*.jsonl` is **truncated to zero bytes** (not deleted), so any writers with open file descriptors continue to work — they will append new lines to the now-empty file.
4. Old archives beyond the `--keep` limit are **pruned**, oldest first.

### Example — before rotation

```
data/logs/
  api.request.jsonl        (62 MB — exceeds 50 MB threshold)
  auth.login.jsonl         (1.2 MB — below threshold)
  all.jsonl                (84 MB — exceeds threshold)
```

### Example — after rotation (--keep 3)

```
data/logs/
  api.request.jsonl                    (0 bytes — truncated)
  api.request.2026-03-07.jsonl.gz      (kept)
  api.request.2026-03-06.jsonl.gz      (kept)
  api.request.2026-03-08.jsonl.gz      (new archive)
  auth.login.jsonl                     (unchanged)
  all.jsonl                            (0 bytes — truncated)
  all.2026-03-08.jsonl.gz              (new archive)
```

The oldest archive (`2026-03-05.jsonl.gz`, if it existed) would have been pruned to stay within `--keep 3`.

## Monthly DB Archiving (`--archive-db`)

When `--archive-db` is passed, the script opens `structured.db` and:

1. Finds all distinct calendar months (format `YYYY-MM`) present in `structured_logs` and `server_logs` that are **older than the current month**.
2. For each such month, opens (or creates) `data/logs/archive/<YYYY-MM>.db`.
3. Copies the matching rows into the archive database using `INSERT OR IGNORE` — idempotent.
4. Deletes the copied rows from the main database to keep it lean.

### Archive database schema

Each `archive/YYYY-MM.db` has the same `structured_logs` and `server_logs` tables as the main database, with the same columns and unique constraints, so queries work identically against archive files.

### Example

```
data/logs/
  structured.db          (contains rows from 2026-03 only)
  archive/
    2026-01.db           (all rows from January)
    2026-02.db           (all rows from February)
```

To query across months, `ATTACH` the archive:

```sql
ATTACH 'data/logs/archive/2026-02.db' AS feb;

SELECT time, event, message
FROM feb.structured_logs
WHERE level = 'error'
ORDER BY time;
```

## Output

The script prints a single JSON summary to stdout:

```json
{
  "dryRun": false,
  "rotations": [
    {
      "file": "api.request.jsonl",
      "sizeMB": 62.4,
      "archive": "api.request.2026-03-08.jsonl.gz",
      "pruned": ["api.request.2026-03-04.jsonl.gz"]
    }
  ],
  "archives": [{ "month": "2026-02", "rows": 18420, "db": "2026-02.db" }]
}
```

## Examples

### Standard daily run (50 MB threshold, keep 3)

```bash
bun scripts/log-rotate.ts
```

### Rotate with monthly DB archiving

```bash
bun scripts/log-rotate.ts --archive-db --verbose
```

### Custom threshold and retention

```bash
bun scripts/log-rotate.ts --threshold 104857600 --keep 7
# threshold: 100 MB, keep last 7 archives per event
```

### Dry run to preview without changes

```bash
bun scripts/log-rotate.ts --dry-run --verbose
```

```
[log-rotate] dir       = /home/user/openclaw/data/logs
[log-rotate] threshold = 50.0 MB
[log-rotate] keep      = 3
[log-rotate] Rotating api.request.jsonl (62.4 MB) → api.request.2026-03-08.jsonl.gz
[log-rotate]   Pruning old archive: api.request.2026-03-04.jsonl.gz
```

### Keep all archives (no pruning)

```bash
bun scripts/log-rotate.ts --keep 0
```

## Environment Variables

| Variable                 | Description                                   |
| ------------------------ | --------------------------------------------- |
| `OPENCLAW_EVENT_LOG_DIR` | Default log directory (overridden by `--dir`) |

## Restoring from an Archive

Decompress a `.jsonl.gz` archive and use it with any standard JSONL tool or the [log viewer](log-view.md):

```bash
gunzip -c data/logs/api.request.2026-03-07.jsonl.gz > /tmp/api.request.2026-03-07.jsonl

OPENCLAW_EVENT_LOG_DIR=/tmp \
  bun scripts/log-view.ts --event api.request.2026-03-07 --level error
```
