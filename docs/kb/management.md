---
summary: "List, delete, and inspect knowledge base sources"
read_when:
  - You want to see what is in the knowledge base
  - You want to remove a source and its chunks
  - You want to check KB health and storage statistics
title: "Management"
---

# Management

## Status and health check

Run preflight checks and show storage statistics:

```bash
bun scripts/kb/index.ts status
```

Output includes:

- Directory and database existence
- SQLite magic-byte integrity check
- Lock file state (active or stale)
- Total source count and chunk count
- Path to the database file

Run this before troubleshooting ingestion or query failures.

## List sources

```bash
bun scripts/kb/index.ts list
```

Output:

```
ID     TYPE       CHUNKS  DATE         TAGS                 | TITLE
────────────────────────────────────────────────────────────────────────────────
4      article    12      2024-11-03   papers,ml            | Attention Is All You Need
7      article    8       2024-11-10   ml,tutorials         | Illustrated Transformer
9      pdf        31      2024-11-15   papers               | PDF document
```

### List filters

| Flag                 | Description                                                  |
| -------------------- | ------------------------------------------------------------ |
| `--source-type TYPE` | Filter by source type (`article`, `tweet`, `youtube`, `pdf`) |
| `--tags t1,t2`       | Show only sources with at least one matching tag             |
| `--limit N`          | Cap the number of rows shown                                 |

Examples:

```bash
# Show only PDFs
bun scripts/kb/index.ts list --source-type pdf

# Show sources tagged "weekly", latest 20
bun scripts/kb/index.ts list --tags weekly --limit 20

# Show all tweets
bun scripts/kb/index.ts list --source-type tweet
```

## Delete a source

Deletes a source and all its chunks (cascade delete in SQLite):

```bash
bun scripts/kb/index.ts delete <id>
```

The ID comes from the `list` output. Example:

```bash
bun scripts/kb/index.ts delete 9
# [kb] Deleted source #9: "PDF document".
```

## Preflight checks

Preflight runs automatically before every command. It validates:

1. **KB directory** — exists and is a directory (created automatically if absent).
2. **Database file** — exists, is non-zero, and passes a SQLite magic-byte check
   (first 6 bytes must be `SQLite`).
3. **Lock file** — if present, checks whether the owning PID is still alive.
   A stale lock from a dead process is reported as a warning.

Preflight errors (corrupted database, wrong file type) abort the command with a
non-zero exit code. Warnings are printed but do not block the command.

### Stale lock recovery

If a lock file is present but the process is dead:

```bash
# Status shows the stale lock
bun scripts/kb/index.ts status
# WARN  Stale lock file found (PID=12345 is dead). …

# Delete the lock manually
rm ~/.openclaw/kb/ingest.lock

# Then re-run the ingestion
bun scripts/kb/index.ts ingest <url>
```

## Database location

The SQLite database is at:

```
~/.openclaw/kb/knowledge.db
```

It contains two tables:

**`sources`**

| Column        | Type    | Description                                        |
| ------------- | ------- | -------------------------------------------------- |
| `id`          | INTEGER | Primary key                                        |
| `url`         | TEXT    | Cleaned source URL (unique)                        |
| `title`       | TEXT    | Extracted or inferred title                        |
| `source_type` | TEXT    | `article`, `tweet`, `youtube`, `pdf`, or `unknown` |
| `tags`        | TEXT    | JSON array of tag strings                          |
| `fetched_at`  | INTEGER | Unix timestamp (ms) of ingest                      |
| `chunk_count` | INTEGER | Number of chunks for this source                   |

**`chunks`**

| Column        | Type    | Description                                     |
| ------------- | ------- | ----------------------------------------------- |
| `id`          | INTEGER | Primary key                                     |
| `source_id`   | INTEGER | Foreign key → `sources.id` (cascade delete)     |
| `chunk_index` | INTEGER | Position within the source (0-based)            |
| `content`     | TEXT    | Raw chunk text                                  |
| `embedding`   | BLOB    | Packed `Float32Array` (384 floats = 1536 bytes) |
| `token_count` | INTEGER | Estimated token count                           |

The database uses WAL journal mode for reliability during concurrent reads.
