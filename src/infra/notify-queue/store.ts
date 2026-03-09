import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { resolveRequiredHomeDir } from "../../infra/home-dir.js";
import { requireNodeSqlite } from "../../memory/sqlite.js";

// ============================================================================
// Types
// ============================================================================

export type NotifyTier = "critical" | "high" | "medium";

export interface NotifyQueueEntry {
  id: string;
  tier: NotifyTier;
  channel: string;
  topic?: string;
  message: string;
  messageType?: string;
  enqueuedAt: number;
  deliveredAt?: number;
  metadata?: Record<string, unknown>;
}

export interface EnqueueNotifyParams {
  tier: NotifyTier;
  channel: string;
  topic?: string;
  message: string;
  messageType?: string;
  metadata?: Record<string, unknown>;
}

export interface DigestGroup {
  channel: string;
  topic?: string;
  messages: string[];
}

// ============================================================================
// Path resolution
// ============================================================================

export function resolveNotifyQueueDbPath(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = () => resolveRequiredHomeDir(env, os.homedir),
): string {
  return path.join(resolveStateDir(env, homedir), "notify-queue.sqlite");
}

// ============================================================================
// DB Handle Cache
// ============================================================================

// Keyed by absolute DB file path to avoid re-opening on every call.
const DB_CACHE = new Map<string, import("node:sqlite").DatabaseSync>();

export function openNotifyQueueDb(
  dbPath?: string,
  env: NodeJS.ProcessEnv = process.env,
): import("node:sqlite").DatabaseSync {
  const resolvedPath = dbPath ?? resolveNotifyQueueDbPath(env);
  const cached = DB_CACHE.get(resolvedPath);
  if (cached) {
    return cached;
  }
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(resolvedPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  ensureNotifyQueueSchema(db);
  DB_CACHE.set(resolvedPath, db);
  return db;
}

/** Clear all cached handles (used in tests to reset state between runs). */
export function clearNotifyQueueDbCacheForTest(): void {
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

export function ensureNotifyQueueSchema(db: import("node:sqlite").DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notify_queue (
      id            TEXT PRIMARY KEY,
      tier          TEXT NOT NULL CHECK(tier IN ('critical','high','medium')),
      channel       TEXT NOT NULL,
      topic         TEXT,
      message       TEXT NOT NULL,
      message_type  TEXT,
      enqueued_at   INTEGER NOT NULL,
      delivered_at  INTEGER,
      metadata_json TEXT
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_nq_tier_delivered
      ON notify_queue(tier, delivered_at)
      WHERE delivered_at IS NULL;
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_nq_channel_topic
      ON notify_queue(channel, topic)
      WHERE delivered_at IS NULL;
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS notify_queue_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  db.exec(`INSERT OR IGNORE INTO notify_queue_meta (key, value) VALUES ('schema_version', '1');`);
}

// ============================================================================
// CRUD Operations
// ============================================================================

type NotifyRow = {
  id: string;
  tier: string;
  channel: string;
  topic: string | null;
  message: string;
  message_type: string | null;
  enqueued_at: number;
  delivered_at: number | null;
  metadata_json: string | null;
};

function rowToEntry(row: NotifyRow): NotifyQueueEntry {
  const entry: NotifyQueueEntry = {
    id: row.id,
    tier: row.tier as NotifyTier,
    channel: row.channel,
    message: row.message,
    enqueuedAt: row.enqueued_at,
  };
  if (row.topic) {
    entry.topic = row.topic;
  }
  if (row.message_type) {
    entry.messageType = row.message_type;
  }
  if (row.delivered_at) {
    entry.deliveredAt = row.delivered_at;
  }
  if (row.metadata_json) {
    try {
      entry.metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
    } catch {
      // ignore malformed metadata
    }
  }
  return entry;
}

/** Add a new notification to the queue. Returns the generated entry ID. */
export function enqueueNotification(
  db: import("node:sqlite").DatabaseSync,
  params: EnqueueNotifyParams,
): string {
  const id = randomUUID();
  const now = Date.now();
  const metadataJson = params.metadata ? JSON.stringify(params.metadata) : null;
  db.prepare(
    `INSERT INTO notify_queue (id, tier, channel, topic, message, message_type, enqueued_at, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    params.tier,
    params.channel,
    params.topic ?? null,
    params.message,
    params.messageType ?? null,
    now,
    metadataJson,
  );
  return id;
}

/** Fetch all undelivered entries for the given tier, ordered by enqueue time. */
export function fetchPendingByTier(
  db: import("node:sqlite").DatabaseSync,
  tier: NotifyTier,
): NotifyQueueEntry[] {
  const rows = db
    .prepare(
      `SELECT * FROM notify_queue
       WHERE tier = ? AND delivered_at IS NULL
       ORDER BY enqueued_at ASC`,
    )
    .all(tier) as NotifyRow[];
  return rows.map(rowToEntry);
}

/** Mark a set of entries as delivered (now). Uses a transaction for atomicity. */
export function markDelivered(db: import("node:sqlite").DatabaseSync, ids: string[]): void {
  if (ids.length === 0) {
    return;
  }
  const now = Date.now();
  // SQLite has a 999-parameter limit; chunk to be safe.
  const CHUNK = 90;

  const markChunk = (chunk: string[]) => {
    const placeholders = chunk.map(() => "?").join(",");
    db.prepare(`UPDATE notify_queue SET delivered_at = ? WHERE id IN (${placeholders})`).run(
      now,
      ...chunk,
    );
  };

  db.exec("BEGIN");
  try {
    for (let i = 0; i < ids.length; i += CHUNK) {
      markChunk(ids.slice(i, i + CHUNK));
    }
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ignore rollback failure
    }
    throw err;
  }
}

/** Count pending (undelivered) entries per tier. */
export function countPendingByTier(
  db: import("node:sqlite").DatabaseSync,
): Record<NotifyTier, number> {
  const rows = db
    .prepare(
      `SELECT tier, COUNT(*) as cnt FROM notify_queue
       WHERE delivered_at IS NULL
       GROUP BY tier`,
    )
    .all() as Array<{ tier: string; cnt: number }>;

  const result: Record<NotifyTier, number> = { critical: 0, high: 0, medium: 0 };
  for (const row of rows) {
    if (row.tier === "critical" || row.tier === "high" || row.tier === "medium") {
      result[row.tier] = row.cnt;
    }
  }
  return result;
}

/** List all pending entries (optionally filtered by tier). */
export function listPending(
  db: import("node:sqlite").DatabaseSync,
  tier?: NotifyTier,
): NotifyQueueEntry[] {
  const rows = tier
    ? (db
        .prepare(
          `SELECT * FROM notify_queue WHERE tier = ? AND delivered_at IS NULL ORDER BY enqueued_at ASC`,
        )
        .all(tier) as NotifyRow[])
    : (db
        .prepare(`SELECT * FROM notify_queue WHERE delivered_at IS NULL ORDER BY enqueued_at ASC`)
        .all() as NotifyRow[]);
  return rows.map(rowToEntry);
}

/** Remove entries that were delivered more than maxAgeMs milliseconds ago. */
export function pruneDelivered(
  db: import("node:sqlite").DatabaseSync,
  maxAgeMs: number = 7 * 24 * 60 * 60 * 1000, // 7 days default
): number {
  const cutoff = Date.now() - maxAgeMs;
  const result = db
    .prepare(`DELETE FROM notify_queue WHERE delivered_at IS NOT NULL AND delivered_at < ?`)
    .run(cutoff) as { changes: number };
  return result.changes;
}
