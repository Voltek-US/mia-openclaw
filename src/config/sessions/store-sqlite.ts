import fs from "node:fs";
import path from "node:path";
import { requireNodeSqlite } from "../../memory/sqlite.js";
import type { SessionEntry } from "./types.js";

// ============================================================================
// Session SQLite DB Handle Cache
// ============================================================================

// Per-directory DatabaseSync handle cache — avoids re-opening on every call.
const DB_CACHE = new Map<string, import("node:sqlite").DatabaseSync>();

/** Open (or reuse a cached) DatabaseSync for a given sessions directory.
 *  Returns null if node:sqlite is unavailable (graceful fallback to JSON). */
export function openSessionDb(sessionsDir: string): import("node:sqlite").DatabaseSync | null {
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
  // Ensure the sessions directory exists before opening the DB file.
  try {
    fs.mkdirSync(sessionsDir, { recursive: true });
  } catch {
    // ignore — directory may already exist or be read-only
  }
  const dbPath = path.join(sessionsDir, "sessions.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = OFF");
  ensureSessionDbSchema(db);
  DB_CACHE.set(sessionsDir, db);
  return db;
}

/** Clear all cached DB handles (used in tests to reset state between test runs). */
export function clearSessionDbCacheForTest(): void {
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

/** Initialize the sessions schema. Idempotent — safe to call on every open. */
export function ensureSessionDbSchema(db: import("node:sqlite").DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_key     TEXT PRIMARY KEY,
      session_id      TEXT NOT NULL,
      updated_at      INTEGER NOT NULL,
      session_file    TEXT,
      channel         TEXT,
      last_channel    TEXT,
      last_to         TEXT,
      last_account_id TEXT,
      chat_type       TEXT,
      entry_json      TEXT NOT NULL,
      created_at      INTEGER NOT NULL
    );
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_updated_at   ON sessions(updated_at);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_session_id   ON sessions(session_id);`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_sessions_channel      ON sessions(channel) WHERE channel IS NOT NULL;`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_sessions_last_channel ON sessions(last_channel) WHERE last_channel IS NOT NULL;`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_sessions_chat_type    ON sessions(chat_type) WHERE chat_type IS NOT NULL;`,
  );

  db.exec(`INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('schema_version', '1');`);
}

// ============================================================================
// CRUD Operations
// ============================================================================

type SessionRow = {
  session_key: string;
  session_id: string;
  updated_at: number;
  session_file: string | null;
  channel: string | null;
  last_channel: string | null;
  last_to: string | null;
  last_account_id: string | null;
  chat_type: string | null;
  entry_json: string;
  created_at: number;
};

function rowToEntry(row: SessionRow): SessionEntry {
  try {
    return JSON.parse(row.entry_json) as SessionEntry;
  } catch {
    // Malformed entry_json — return a minimal shell so the session key survives.
    return { sessionId: row.session_id, updatedAt: row.updated_at } as SessionEntry;
  }
}

/** Load all sessions from SQLite. Returns the same shape as the JSON store. */
export function loadAllSessionsFromDb(
  db: import("node:sqlite").DatabaseSync,
): Record<string, SessionEntry> {
  const rows = db.prepare("SELECT * FROM sessions").all() as SessionRow[];
  const store: Record<string, SessionEntry> = {};
  for (const row of rows) {
    store[row.session_key] = rowToEntry(row);
  }
  return store;
}

/** Read a single entry by normalized session key. */
export function getSessionEntry(
  db: import("node:sqlite").DatabaseSync,
  sessionKey: string,
): SessionEntry | undefined {
  const row = db.prepare("SELECT * FROM sessions WHERE session_key = ?").get(sessionKey) as
    | SessionRow
    | undefined;
  return row ? rowToEntry(row) : undefined;
}

/** Read entries whose session_key lowercased equals normalizedKey (handles legacy casing variants). */
export function getSessionEntriesByKeyPrefix(
  db: import("node:sqlite").DatabaseSync,
  normalizedKey: string,
): Array<{ key: string; entry: SessionEntry }> {
  // SQLite LIKE is case-insensitive for ASCII — use it to find variant-cased keys.
  const rows = db
    .prepare("SELECT * FROM sessions WHERE lower(session_key) = lower(?)")
    .all(normalizedKey) as SessionRow[];
  return rows.map((row) => ({ key: row.session_key, entry: rowToEntry(row) }));
}

/** Upsert a SessionEntry. Preserves created_at if row already exists. */
export function upsertSessionEntry(
  db: import("node:sqlite").DatabaseSync,
  sessionKey: string,
  entry: SessionEntry,
): void {
  const now = Date.now();
  const existing = db
    .prepare("SELECT created_at FROM sessions WHERE session_key = ?")
    .get(sessionKey) as { created_at: number } | undefined;
  const createdAt = existing?.created_at ?? now;

  db.prepare(`
    INSERT OR REPLACE INTO sessions
      (session_key, session_id, updated_at, session_file, channel, last_channel,
       last_to, last_account_id, chat_type, entry_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionKey,
    entry.sessionId ?? "",
    entry.updatedAt ?? now,
    entry.sessionFile ?? null,
    ((entry as Record<string, unknown>).channel as string | null) ?? null,
    ((entry as Record<string, unknown>).lastChannel as string | null) ?? null,
    ((entry as Record<string, unknown>).lastTo as string | null) ?? null,
    ((entry as Record<string, unknown>).lastAccountId as string | null) ?? null,
    entry.chatType ?? null,
    JSON.stringify(entry),
    createdAt,
  );
}

/** Delete a set of session entries by key. */
export function deleteSessionEntries(
  db: import("node:sqlite").DatabaseSync,
  sessionKeys: string[],
): void {
  if (sessionKeys.length === 0) {
    return;
  }
  // SQLite has a max of 999 parameters; chunk if needed.
  const chunkSize = 900;
  for (let i = 0; i < sessionKeys.length; i += chunkSize) {
    const chunk = sessionKeys.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => "?").join(", ");
    db.prepare(`DELETE FROM sessions WHERE session_key IN (${placeholders})`).run(...chunk);
  }
}

/** Prune entries older than cutoffMs. Returns the count of deleted rows. */
export function pruneSessionsOlderThan(
  db: import("node:sqlite").DatabaseSync,
  cutoffMs: number,
): number {
  // Collect pruned keys so callers can remove them from in-memory stores too.
  const rows = db
    .prepare("SELECT session_key FROM sessions WHERE updated_at < ?")
    .all(cutoffMs) as Array<{ session_key: string }>;
  if (rows.length === 0) {
    return 0;
  }
  const keys = rows.map((r) => r.session_key);
  deleteSessionEntries(db, keys);
  return keys.length;
}

/** Prune entries older than cutoffMs and return the deleted session keys. */
export function pruneSessionsOlderThanWithKeys(
  db: import("node:sqlite").DatabaseSync,
  cutoffMs: number,
): string[] {
  const rows = db
    .prepare("SELECT session_key FROM sessions WHERE updated_at < ?")
    .all(cutoffMs) as Array<{ session_key: string }>;
  if (rows.length === 0) {
    return [];
  }
  const keys = rows.map((r) => r.session_key);
  deleteSessionEntries(db, keys);
  return keys;
}

/** Cap total session count to maxEntries (keep most recently updated). Returns deleted keys. */
export function capSessionCount(
  db: import("node:sqlite").DatabaseSync,
  maxEntries: number,
): string[] {
  if (maxEntries <= 0) {
    return [];
  }
  const rows = db
    .prepare(
      `SELECT session_key FROM sessions
       WHERE session_key NOT IN (
         SELECT session_key FROM sessions ORDER BY updated_at DESC LIMIT ?
       )`,
    )
    .all(maxEntries) as Array<{ session_key: string }>;
  if (rows.length === 0) {
    return [];
  }
  const keys = rows.map((r) => r.session_key);
  deleteSessionEntries(db, keys);
  return keys;
}

/** Return total number of session rows. */
export function getSessionCount(db: import("node:sqlite").DatabaseSync): number {
  const row = db.prepare("SELECT COUNT(*) as count FROM sessions").get() as { count: number };
  return row.count;
}

/** Batch-upsert all entries in a single transaction (used by saveSessionStore). */
export function batchUpsertSessions(
  db: import("node:sqlite").DatabaseSync,
  store: Record<string, SessionEntry>,
): void {
  db.exec("BEGIN");
  try {
    for (const [key, entry] of Object.entries(store)) {
      if (entry) {
        upsertSessionEntry(db, key, entry);
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ignore rollback errors
    }
    throw err;
  }
}

/**
 * Full-sync: upsert all entries in `store` AND delete any SQLite rows whose
 * keys are not present in `store`. This correctly handles cases where keys
 * are removed from the in-memory store (e.g. legacy key normalization or
 * maintenance pruning/capping).
 */
export function syncSessionsToDb(
  db: import("node:sqlite").DatabaseSync,
  store: Record<string, SessionEntry>,
): void {
  const storeKeys = new Set(Object.keys(store));
  const dbRows = db.prepare("SELECT session_key FROM sessions").all() as Array<{
    session_key: string;
  }>;
  const toDelete = dbRows.map((r) => r.session_key).filter((k) => !storeKeys.has(k));

  db.exec("BEGIN");
  try {
    // Delete keys no longer in the store.
    if (toDelete.length > 0) {
      deleteSessionEntries(db, toDelete);
    }
    // Upsert all current entries.
    for (const [key, entry] of Object.entries(store)) {
      if (entry) {
        upsertSessionEntry(db, key, entry);
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ignore rollback errors
    }
    throw err;
  }
}
