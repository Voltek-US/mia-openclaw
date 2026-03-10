import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { loadSqliteVecExtension, requireNodeSqlite } from "openclaw/plugin-sdk/knowledge-base";

export type KbDb = {
  db: DatabaseSync;
  vecAvailable: boolean;
  dbPath: string;
};

export type PreflightResult = {
  ok: boolean;
  vecAvailable: boolean;
  issues: string[];
};

// Keyed by absolute DB path to avoid re-opening.
const DB_CACHE = new Map<string, KbDb>();

export function resolveKbDbPath(): string {
  return process.env.OPENCLAW_KB_DB || path.join(os.homedir(), ".openclaw", "kb.db");
}

export function resolveLockPath(dbPath: string): string {
  return path.join(path.dirname(dbPath), ".kb.lock");
}

export async function openKbDb(dbPath?: string): Promise<KbDb> {
  const resolved = path.resolve(dbPath ?? resolveKbDbPath());

  const cached = DB_CACHE.get(resolved);
  if (cached) {
    return cached;
  }

  // Ensure parent directory exists.
  await fs.mkdir(path.dirname(resolved), { recursive: true });

  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(resolved);

  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");

  initSchema(db);

  const vecResult = await loadSqliteVecExtension({ db });

  const kbDb: KbDb = { db, vecAvailable: vecResult.ok, dbPath: resolved };
  DB_CACHE.set(resolved, kbDb);
  return kbDb;
}

function initSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kb_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS kb_sources (
      id          TEXT PRIMARY KEY,
      url         TEXT NOT NULL UNIQUE,
      title       TEXT NOT NULL DEFAULT '',
      source_type TEXT NOT NULL CHECK(source_type IN ('article','tweet','youtube','pdf','howto','prompt','issue')),
      tags        TEXT NOT NULL DEFAULT '[]',
      ingested_at INTEGER NOT NULL,
      status      TEXT NOT NULL DEFAULT 'ok' CHECK(status IN ('ok','error','pending'))
    );

    CREATE INDEX IF NOT EXISTS idx_kb_sources_type ON kb_sources(source_type);
    CREATE INDEX IF NOT EXISTS idx_kb_sources_ts   ON kb_sources(ingested_at);

    CREATE TABLE IF NOT EXISTS kb_chunks (
      id          TEXT PRIMARY KEY,
      source_id   TEXT NOT NULL REFERENCES kb_sources(id) ON DELETE CASCADE,
      chunk_idx   INTEGER NOT NULL,
      text        TEXT NOT NULL,
      token_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_kb_chunks_src ON kb_chunks(source_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunks_fts USING fts5(
      text, id UNINDEXED, source_id UNINDEXED
    );
  `);
}

/**
 * Ensure the vec0 virtual table exists with the given embedding dimension.
 * Creates it on first call and validates dimension consistency on subsequent calls.
 * Throws if the stored dimension mismatches the current provider.
 */
export function ensureVecTable(db: DatabaseSync, dim: number): void {
  const row = db.prepare("SELECT value FROM kb_meta WHERE key = 'embedding_dim'").get() as
    | { value: string }
    | undefined;

  if (row) {
    const storedDim = parseInt(row.value, 10);
    if (storedDim !== dim) {
      throw new Error(
        `KB embedding dimension mismatch: database has dim=${storedDim} but current provider returns dim=${dim}. ` +
          `Run \`openclaw kb status\` for details. To rebuild vectors, delete ~/.openclaw/kb.db and re-ingest.`,
      );
    }
    return; // Table already exists and dim matches.
  }

  // First ingest: create the vec0 table.
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunks_vec USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[${dim}])`,
  );
  db.prepare("INSERT OR REPLACE INTO kb_meta(key, value) VALUES('embedding_dim', ?)").run(
    String(dim),
  );
}

/** Clear cached handles (test isolation). */
export function clearKbDbCacheForTest(): void {
  for (const kbDb of DB_CACHE.values()) {
    try {
      kbDb.db.close();
    } catch {
      // ignore
    }
  }
  DB_CACHE.clear();
}

export async function runPreflightChecks(dbPath: string): Promise<PreflightResult> {
  const issues: string[] = [];
  const dir = path.dirname(dbPath);

  // Check parent directory exists.
  try {
    await fs.access(dir);
  } catch {
    issues.push(`DB directory does not exist: ${dir}`);
  }

  // Check for stale lock file.
  const lockPath = resolveLockPath(dbPath);
  try {
    const lockRaw = await fs.readFile(lockPath, "utf8");
    const lock = JSON.parse(lockRaw) as { pid?: number; createdAt?: string };
    if (typeof lock.pid === "number" && !isPidAlive(lock.pid)) {
      try {
        await fs.rm(lockPath, { force: true });
        issues.push(`Removed stale lock file (PID ${lock.pid} was dead).`);
      } catch {
        issues.push(`Stale lock file exists and could not be removed: ${lockPath}`);
      }
    }
  } catch {
    // Lock file absent or unreadable — fine.
  }

  // Check DB integrity if file exists.
  let vecAvailable = false;
  try {
    await fs.access(dbPath);
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const result = db.prepare("PRAGMA integrity_check").get() as
        | { integrity_check: string }
        | undefined;
      if (!result || result.integrity_check !== "ok") {
        issues.push(`SQLite integrity check failed: ${result?.integrity_check ?? "unknown"}`);
      }
      // Try loading sqlite-vec extension to report availability.
      const vecResult = await loadSqliteVecExtension({ db });
      vecAvailable = vecResult.ok;
    } finally {
      db.close();
    }
  } catch (err) {
    if ((err as { code?: string }).code !== "ENOENT") {
      issues.push(`Could not open DB for integrity check: ${String(err)}`);
    }
    // DB doesn't exist yet — that's fine for a fresh install.
  }

  return { ok: issues.filter((i) => !i.startsWith("Removed")).length === 0, vecAvailable, issues };
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
