---
summary: "SQLite-backed session store: architecture, migration, environment flags, and internals"
read_when:
  - You want to understand how sessions are stored in SQLite
  - You are debugging sessions.sqlite or the JSON migration
  - You are writing code that touches the session store
title: "Session Store: SQLite Backend"
---

# Session Store: SQLite Backend

OpenClaw stores session metadata in a **SQLite database** (`sessions.sqlite`) instead of a flat JSON file (`sessions.json`). This provides faster single-entry reads and writes, safe concurrent access via WAL mode, and efficient filtering without loading the entire store.

JSONL transcript files (`*.jsonl`) are **not** affected — they continue to live alongside the database.

---

## On-disk layout

Per agent, on the gateway host:

```
~/.openclaw/agents/<agentId>/sessions/
  sessions.sqlite       ← primary store (SQLite, WAL mode)
  sessions.sqlite-wal   ← WAL journal (auto-managed)
  sessions.sqlite-shm   ← shared-memory index (auto-managed)
  sessions.json         ← JSON backup (dual-written by default; read during migration)
  <sessionId>.jsonl     ← transcript files (unchanged)
```

---

## Schema

```sql
CREATE TABLE schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE sessions (
  session_key     TEXT PRIMARY KEY,   -- normalized (lowercased, trimmed)
  session_id      TEXT NOT NULL,
  updated_at      INTEGER NOT NULL,   -- epoch ms; used for prune/cap/sort
  session_file    TEXT,               -- path to JSONL transcript
  channel         TEXT,
  last_channel    TEXT,
  last_to         TEXT,
  last_account_id TEXT,
  chat_type       TEXT,
  entry_json      TEXT NOT NULL,      -- full SessionEntry as JSON blob
  created_at      INTEGER NOT NULL    -- epoch ms; set once on INSERT, never updated
);
```

Indexes on `updated_at`, `session_id`, `channel`, `last_channel`, and `chat_type` cover the common query patterns. All other `SessionEntry` fields live inside `entry_json` — no schema migration is needed when new optional fields are added.

`schema_meta` tracks:

- `schema_version` — set to `'1'` on first open
- `json_migration_done` — set to `'true'` after the one-time import from `sessions.json`

---

## One-time migration from sessions.json

On the **first open** of a sessions directory, OpenClaw:

1. Checks `schema_meta` for `json_migration_done`.
2. If not set, reads `sessions.json` (if it exists), applies in-memory field migrations (`applySessionStoreMigrations`), and batch-inserts all entries into SQLite in a single transaction.
3. Marks `json_migration_done = 'true'` in `schema_meta`.

This is transparent and automatic — existing installs migrate on the next gateway start with no manual action required.

If `sessions.json` does not exist (fresh install), migration is marked done immediately (nothing to import).

---

## Read and write path

**Load** (`loadSessionStore`):

```
openSessionDb(dir)
  → ensureMigrated (first call only — checks schema_meta, imports JSON if needed)
  → check in-process object cache (5-second TTL)
  → loadAllSessionsFromDb (SELECT * FROM sessions)
  → applySessionStoreMigrations (in-memory field renames)
  → write object cache
  → return structuredClone
```

Fallback: if `node:sqlite` is unavailable (Node < 22) or `OPENCLAW_SESSION_SQLITE=0` is set, the existing JSON path is used unchanged.

**Single-entry update** (`updateSessionStoreEntry`):

```
ensureMigrated
  → getSessionEntry (SELECT * WHERE session_key = ?)
  → apply patch
  → upsertSessionEntry (INSERT OR REPLACE)
  → drop object cache
```

No full-store read/write for single-entry updates — this is the key performance improvement over the JSON path.

**Full save** (`saveSessionStoreUnlocked`):

```
syncSessionsToDb (upsert all + delete removed keys in one transaction)
  → markJsonMigrationDone
  → drop object cache
  → if OPENCLAW_SESSION_SQLITE_ONLY=1: return early (skip JSON write)
  → else: atomic JSON write to sessions.json (dual-write backup)
```

---

## Concurrency model

- **In-process lock queue** (`LOCK_QUEUES`): serializes writers within a single process (unchanged from JSON path).
- **Cross-process file lock** (`acquireSessionWriteLock`): serializes writers across gateway processes (unchanged).
- **SQLite WAL mode**: allows concurrent readers while a writer holds the lock. `PRAGMA busy_timeout = 5000` retries reads blocked by a writer for up to 5 seconds before failing.

---

## In-process object cache

A short TTL in-process cache (5 seconds for SQLite, 45 seconds for JSON) reduces `structuredClone` overhead for frequent reads within the same process. Cross-process reads always go to SQLite directly.

The cache is invalidated:

- After any write (via `dropSessionStoreObjectCache`)
- On TTL expiry

---

## Environment flags

| Variable                       | Default | Effect                                                                 |
| ------------------------------ | ------- | ---------------------------------------------------------------------- |
| `OPENCLAW_SESSION_SQLITE`      | `1`     | Set to `0` to force JSON-only path (disables SQLite entirely)          |
| `OPENCLAW_SESSION_SQLITE_ONLY` | `0`     | Set to `1` to skip dual-writing `sessions.json` (SQLite is sole store) |

### Rollout phases

**Phase 1 (current):** SQLite is the primary read/write store. `sessions.json` is dual-written as a backup. Migration from `sessions.json` runs automatically on first open.

**Phase 2 (future):** `OPENCLAW_SESSION_SQLITE_ONLY=1` becomes the default. `sessions.json` becomes a recovery artifact only.

**Phase 3 (future):** Add a `messages` table; shadow-write JSONL transcripts to SQLite for fast full-text and date-range filtering. Transcript JSONL files stay intact.

---

## Inspecting the database

```bash
# List all sessions ordered by most recently updated
sqlite3 ~/.openclaw/agents/main/sessions/sessions.sqlite \
  "SELECT session_key, session_id, datetime(updated_at/1000,'unixepoch') FROM sessions ORDER BY updated_at DESC"

# Check migration status
sqlite3 ~/.openclaw/agents/main/sessions/sessions.sqlite \
  "SELECT * FROM schema_meta"

# Count sessions
sqlite3 ~/.openclaw/agents/main/sessions/sessions.sqlite \
  "SELECT COUNT(*) FROM sessions"

# Look up a specific session key
sqlite3 ~/.openclaw/agents/main/sessions/sessions.sqlite \
  "SELECT entry_json FROM sessions WHERE session_key = 'agent:main:main'"
```

---

## Maintenance (prune and cap)

Session maintenance (`pruneAfter`, `maxEntries`) uses SQL queries instead of full-store loads:

- **Prune**: `DELETE FROM sessions WHERE updated_at < ?`
- **Cap**: `DELETE WHERE session_key NOT IN (SELECT session_key ORDER BY updated_at DESC LIMIT ?)`

Both operations return the deleted keys so the in-memory store stays consistent.

The `rotateSessionFile` step (rotating `sessions.json` when oversized) is a no-op when SQLite is active — WAL handles space recovery automatically.

Maintenance is still triggered on session-store writes and on demand:

```bash
openclaw sessions cleanup --dry-run
openclaw sessions cleanup --enforce
```

---

## Source files

| File                                                                                              | Purpose                                                            |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| [src/config/sessions/store-sqlite.ts](../src/config/sessions/store-sqlite.ts)                     | DB lifecycle, schema, all CRUD and maintenance operations          |
| [src/config/sessions/store-sqlite-migration.ts](../src/config/sessions/store-sqlite-migration.ts) | One-time JSON → SQLite import                                      |
| [src/config/sessions/store.ts](../src/config/sessions/store.ts)                                   | Top-level store API; SQLite primary path with JSON fallback        |
| [src/config/sessions/store-cache.ts](../src/config/sessions/store-cache.ts)                       | In-process object cache (5s TTL for SQLite, 45s for JSON)          |
| [src/config/sessions/paths.ts](../src/config/sessions/paths.ts)                                   | `resolveSessionSqliteStorePath()` — returns `sessions.sqlite` path |

Tests colocated as `*.test.ts` in the same directory.

---

## Troubleshooting

**`unable to open database file`**
The sessions directory did not exist before `openSessionDb` was called. This should not happen in normal operation — `openSessionDb` creates the directory with `fs.mkdirSync({ recursive: true })`. If it recurs, check filesystem permissions on `~/.openclaw/agents/`.

**SQLite unavailable (Node < 22)**
`node:sqlite` is a Node 22+ built-in. On older Node versions, `openSessionDb` returns `null` and the JSON path is used transparently. Upgrade to Node 22+ to enable SQLite.

**Disable SQLite for debugging**

```bash
OPENCLAW_SESSION_SQLITE=0 openclaw gateway run ...
```

This forces the pre-SQLite JSON path without changing any files.

**sessions.json out of sync**
If `sessions.json` diverges from `sessions.sqlite` (for example, after editing it manually), restart the gateway. On next write, `syncSessionsToDb` will reconcile the store: upsert all surviving entries and delete rows no longer in the store.

**`database is locked`**
Indicates two processes are writing without going through the file lock. Confirm only one gateway process is running (`pgrep -a openclaw`). The `busy_timeout = 5000` pragma retries for 5 seconds before returning this error.

---

## Related docs

- [Session Management](/concepts/session)
- [Session Management Deep Dive](/reference/session-management-compaction)
- [Session Pruning](/concepts/session-pruning)
