---
title: "Learnings Database"
summary: "Schema and operations for the SQLite learnings store: three tables for corrections/insights, recurring error patterns, and feature requests."
---

# Learnings Database

The learnings database is a SQLite file that persists across agent sessions. It is the SQL replacement for flat Markdown files (`LEARNINGS.md`, `ERRORS.md`, `FEATURE_REQUESTS.md`).

**File:** `src/agents/tools/learnings-store-sqlite.ts`

**DB path:** `~/.openclaw/agents/<agentId>/sessions/learnings.sqlite`

## Schema

### `learnings` — corrections and insights

Stores corrections made by the user and useful insights discovered during operation.

| Column       | Type       | Description                           |
| ------------ | ---------- | ------------------------------------- |
| `id`         | INTEGER PK | Auto-increment                        |
| `category`   | TEXT       | `correction` or `insight`             |
| `content`    | TEXT       | The learning text                     |
| `source`     | TEXT       | Session key or script name (optional) |
| `created_at` | INTEGER    | Unix ms timestamp                     |
| `updated_at` | INTEGER    | Unix ms timestamp                     |

### `error_patterns` — recurring errors

Deduplicated error signatures captured from tool output. Count increments on each re-occurrence.

| Column      | Type        | Description                             |
| ----------- | ----------- | --------------------------------------- |
| `id`        | INTEGER PK  | Auto-increment                          |
| `pattern`   | TEXT UNIQUE | Normalized error signature (≤120 chars) |
| `count`     | INTEGER     | Number of times seen                    |
| `last_seen` | INTEGER     | Unix ms of most recent occurrence       |
| `example`   | TEXT        | Last raw context snippet                |

### `feature_requests` — improvement ideas

Ideas for automation, features, or improvements proposed by the agent or user.

| Column        | Type       | Description                       |
| ------------- | ---------- | --------------------------------- |
| `id`          | INTEGER PK | Auto-increment                    |
| `title`       | TEXT       | Short description                 |
| `description` | TEXT       | Detail (optional)                 |
| `status`      | TEXT       | `open`, `accepted`, or `rejected` |
| `created_at`  | INTEGER    | Unix ms timestamp                 |

## Exported Functions

```typescript
import {
  openLearningsDb,
  clearLearningsDbCacheForTest,

  // learnings
  recordLearning,
  queryLearnings,

  // error patterns
  upsertErrorPattern,
  queryErrorPatterns,

  // feature requests
  addFeatureRequest,
  queryFeatureRequests,
} from "src/agents/tools/learnings-store-sqlite.js";
```

### `openLearningsDb(sessionsDir)`

Opens (or returns a cached) `DatabaseSync` handle for `learnings.sqlite` in the given directory. Creates the directory and schema if they do not exist. Returns `null` if `node:sqlite` is unavailable in the current runtime.

```typescript
const db = openLearningsDb("~/.openclaw/agents/main/sessions");
if (!db) {
  /* sqlite unavailable, skip */
}
```

### `recordLearning(db, opts)`

Insert a correction or insight row. Returns the new row `id`.

```typescript
recordLearning(db, {
  category: "correction",
  content: "Always use heredoc when passing multi-line strings to gh CLI",
  source: "agent:main:telegram:direct:user123",
});
```

### `queryLearnings(db, opts?)`

Return rows ordered by `created_at DESC`. All options are optional.

```typescript
const rows = queryLearnings(db, {
  category: "correction", // filter by category
  keyword: "heredoc", // LIKE %keyword%
  limit: 10, // default 20
});
```

### `upsertErrorPattern(db, opts)`

Insert a new pattern or increment `count` on an existing one.

```typescript
upsertErrorPattern(db, {
  pattern: "ENOENT: no such file or directory",
  example: "[Bash] rm nonexistent.txt",
});
```

### `queryErrorPatterns(db, opts?)`

Return patterns ordered by frequency (`count DESC`).

```typescript
const rows = queryErrorPatterns(db, { minCount: 3, limit: 20 });
```

### `addFeatureRequest(db, opts)`

Insert a new feature request with `status = 'open'`. Returns the new row `id`.

```typescript
addFeatureRequest(db, {
  title: "Auto-retry on rate limit",
  description: "Wrap API calls with exponential backoff",
});
```

### `queryFeatureRequests(db, opts?)`

Return feature requests ordered by `created_at DESC`.

```typescript
const open = queryFeatureRequests(db, { status: "open", limit: 10 });
```

## Direct SQL Access

Query the database directly with the `sqlite3` CLI:

```bash
sqlite3 ~/.openclaw/agents/main/sessions/learnings.sqlite

# Recent corrections
SELECT created_at, content FROM learnings
WHERE category = 'correction'
ORDER BY created_at DESC LIMIT 10;

# Top error patterns
SELECT pattern, count, last_seen FROM error_patterns
ORDER BY count DESC LIMIT 20;

# Open feature requests
SELECT title, description FROM feature_requests
WHERE status = 'open'
ORDER BY created_at DESC;
```

## Privacy

The learnings database contains Confidential-tier data (personal corrections, session-specific insights). The agent tools that expose it (`learnings_record`, `learnings_query`) are suppressed in group and channel sessions — the same gating used by `memory_search` and `memory_get`.
