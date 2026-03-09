import fs from "node:fs";
import { applySessionStoreMigrations } from "./store-migrations.js";
import { upsertSessionEntry } from "./store-sqlite.js";
import type { SessionEntry } from "./types.js";

type MigrateResult = { migrated: number; skipped: boolean };

const MIGRATION_KEY = "json_migration_done";

function isMigrationDone(db: import("node:sqlite").DatabaseSync): boolean {
  const row = db.prepare("SELECT value FROM schema_meta WHERE key = ?").get(MIGRATION_KEY) as
    | { value: string }
    | undefined;
  return row?.value === "true";
}

function markMigrationDone(db: import("node:sqlite").DatabaseSync): void {
  db.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)").run(
    MIGRATION_KEY,
    "true",
  );
}

function isSessionStoreRecord(value: unknown): value is Record<string, SessionEntry> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readJsonStore(storePath: string): Record<string, SessionEntry> | null {
  // Retry up to 3 times on Windows where atomic renames aren't fully atomic.
  const maxAttempts = process.platform === "win32" ? 3 : 1;
  const retryBuf = maxAttempts > 1 ? new Int32Array(new SharedArrayBuffer(4)) : undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const raw = fs.readFileSync(storePath, "utf-8");
      if (raw.length === 0 && attempt < maxAttempts - 1) {
        Atomics.wait(retryBuf!, 0, 0, 50);
        continue;
      }
      const parsed = JSON.parse(raw);
      if (isSessionStoreRecord(parsed)) {
        return parsed;
      }
      return null;
    } catch {
      if (attempt < maxAttempts - 1) {
        Atomics.wait(retryBuf!, 0, 0, 50);
        continue;
      }
      return null;
    }
  }
  return null;
}

/**
 * One-time import of an existing sessions.json into the SQLite database.
 * Safe to call repeatedly — checks schema_meta for migration state.
 */
export function migrateJsonToSqliteIfNeeded(params: {
  db: import("node:sqlite").DatabaseSync;
  storePath: string;
}): MigrateResult {
  const { db, storePath } = params;

  if (isMigrationDone(db)) {
    return { migrated: 0, skipped: true };
  }

  const store = readJsonStore(storePath);
  if (!store) {
    // No sessions.json to migrate — mark done and return.
    db.exec("BEGIN");
    markMigrationDone(db);
    db.exec("COMMIT");
    return { migrated: 0, skipped: false };
  }

  // Apply in-memory migrations (field renames etc.) before importing.
  applySessionStoreMigrations(store);

  const entries = Object.entries(store).filter(([, entry]) => entry != null);

  db.exec("BEGIN");
  try {
    for (const [key, entry] of entries) {
      upsertSessionEntry(db, key, entry);
    }
    markMigrationDone(db);
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ignore
    }
    throw err;
  }

  return { migrated: entries.length, skipped: false };
}

/**
 * Mark migration as done without importing data.
 * Called from saveSessionStoreUnlocked after writing data directly to SQLite,
 * so subsequent loadSessionStore calls skip the migration read.
 */
export function markJsonMigrationDone(db: import("node:sqlite").DatabaseSync): void {
  if (isMigrationDone(db)) {
    return;
  }
  db.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)").run(
    MIGRATION_KEY,
    "true",
  );
}
