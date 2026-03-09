import fs from "node:fs";
import path from "node:path";
import { requireNodeSqlite } from "../../memory/sqlite.js";

// ============================================================================
// Learnings SQLite DB Handle Cache
// ============================================================================

// Per-directory handle cache — avoids re-opening on every call.
const DB_CACHE = new Map<string, import("node:sqlite").DatabaseSync>();

/** Open (or reuse a cached) DatabaseSync for a given sessions directory.
 *  Returns null if node:sqlite is unavailable. */
export function openLearningsDb(sessionsDir: string): import("node:sqlite").DatabaseSync | null {
  const cached = DB_CACHE.get(sessionsDir);
  if (cached) {
    return cached;
  }
  let DatabaseSync: typeof import("node:sqlite").DatabaseSync;
  try {
    ({ DatabaseSync } = requireNodeSqlite());
  } catch {
    return null;
  }
  try {
    fs.mkdirSync(sessionsDir, { recursive: true });
  } catch {
    // ignore — dir may already exist
  }
  const dbPath = path.join(sessionsDir, "learnings.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = OFF");
  ensureLearningsDbSchema(db);
  DB_CACHE.set(sessionsDir, db);
  return db;
}

/** Clear all cached DB handles (used in tests to reset state between runs). */
export function clearLearningsDbCacheForTest(): void {
  for (const db of DB_CACHE.values()) {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
  DB_CACHE.clear();
}

// ============================================================================
// Schema
// ============================================================================

/** Initialize the learnings schema. Idempotent — safe to call on every open. */
export function ensureLearningsDbSchema(db: import("node:sqlite").DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Learnings: corrections from user feedback and insights from operation.
  db.exec(`
    CREATE TABLE IF NOT EXISTS learnings (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      category   TEXT    NOT NULL,
      content    TEXT    NOT NULL,
      source     TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_learnings_category   ON learnings(category);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_learnings_created_at ON learnings(created_at);`);

  // Error patterns: recurring error signatures with occurrence counts.
  db.exec(`
    CREATE TABLE IF NOT EXISTS error_patterns (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      pattern   TEXT    NOT NULL UNIQUE,
      count     INTEGER NOT NULL DEFAULT 1,
      last_seen INTEGER NOT NULL,
      example   TEXT
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_error_patterns_last_seen ON error_patterns(last_seen);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_error_patterns_count     ON error_patterns(count);`);

  // Feature requests: ideas and automation opportunities.
  db.exec(`
    CREATE TABLE IF NOT EXISTS feature_requests (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      title       TEXT NOT NULL,
      description TEXT,
      status      TEXT NOT NULL DEFAULT 'open',
      created_at  INTEGER NOT NULL
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_feature_requests_status ON feature_requests(status);`);

  db.exec(`INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('schema_version', '1');`);
}

// ============================================================================
// Learnings CRUD
// ============================================================================

export type LearningRow = {
  id: number;
  category: string;
  content: string;
  source: string | null;
  created_at: number;
  updated_at: number;
};

/** Insert a new learning entry. Returns the new row id. */
export function recordLearning(
  db: import("node:sqlite").DatabaseSync,
  opts: { category: string; content: string; source?: string },
): number {
  const now = Date.now();
  const result = db
    .prepare(
      `INSERT INTO learnings (category, content, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(opts.category, opts.content, opts.source ?? null, now, now);
  return Number(result.lastInsertRowid);
}

/** Query learnings by optional category and/or keyword. */
export function queryLearnings(
  db: import("node:sqlite").DatabaseSync,
  opts: { category?: string; keyword?: string; limit?: number } = {},
): LearningRow[] {
  const { category, keyword, limit = 20 } = opts;
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (category) {
    conditions.push("category = ?");
    params.push(category);
  }
  if (keyword) {
    conditions.push("content LIKE ?");
    params.push(`%${keyword}%`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return db
    .prepare(`SELECT * FROM learnings ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...params, limit) as LearningRow[];
}

// ============================================================================
// Error Pattern CRUD
// ============================================================================

export type ErrorPatternRow = {
  id: number;
  pattern: string;
  count: number;
  last_seen: number;
  example: string | null;
};

/** Upsert an error pattern — increments count if it already exists. */
export function upsertErrorPattern(
  db: import("node:sqlite").DatabaseSync,
  opts: { pattern: string; example?: string },
): void {
  const now = Date.now();
  db.prepare(`
    INSERT INTO error_patterns (pattern, count, last_seen, example)
    VALUES (?, 1, ?, ?)
    ON CONFLICT(pattern) DO UPDATE SET
      count     = count + 1,
      last_seen = excluded.last_seen,
      example   = excluded.example
  `).run(opts.pattern, now, opts.example ?? null);
}

/** Query error patterns ordered by frequency. */
export function queryErrorPatterns(
  db: import("node:sqlite").DatabaseSync,
  opts: { minCount?: number; limit?: number } = {},
): ErrorPatternRow[] {
  const { minCount = 1, limit = 20 } = opts;
  return db
    .prepare(
      `SELECT * FROM error_patterns WHERE count >= ? ORDER BY count DESC, last_seen DESC LIMIT ?`,
    )
    .all(minCount, limit) as ErrorPatternRow[];
}

// ============================================================================
// Feature Request CRUD
// ============================================================================

export type FeatureRequestRow = {
  id: number;
  title: string;
  description: string | null;
  status: string;
  created_at: number;
};

/** Add a new feature request. Returns the new row id. */
export function addFeatureRequest(
  db: import("node:sqlite").DatabaseSync,
  opts: { title: string; description?: string },
): number {
  const now = Date.now();
  const result = db
    .prepare(
      `INSERT INTO feature_requests (title, description, status, created_at)
       VALUES (?, ?, 'open', ?)`,
    )
    .run(opts.title, opts.description ?? null, now);
  return Number(result.lastInsertRowid);
}

/** Query feature requests by optional status. */
export function queryFeatureRequests(
  db: import("node:sqlite").DatabaseSync,
  opts: { status?: string; limit?: number } = {},
): FeatureRequestRow[] {
  const { status, limit = 20 } = opts;
  if (status) {
    return db
      .prepare(`SELECT * FROM feature_requests WHERE status = ? ORDER BY created_at DESC LIMIT ?`)
      .all(status, limit) as FeatureRequestRow[];
  }
  return db
    .prepare(`SELECT * FROM feature_requests ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as FeatureRequestRow[];
}
