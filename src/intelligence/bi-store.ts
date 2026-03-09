import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireNodeSqlite } from "../memory/sqlite.js";

// ============================================================================
// DB path resolution
// ============================================================================

export function resolveBiDbDir(): string {
  const override = process.env.COUNCIL_DB_DIR?.trim();
  if (override) {
    return path.resolve(override);
  }
  const home = process.env.OPENCLAW_HOME ?? path.join(os.homedir(), ".openclaw");
  return path.join(home, "intelligence");
}

// ============================================================================
// DB Handle Cache (per-directory)
// ============================================================================

const DB_CACHE = new Map<string, import("node:sqlite").DatabaseSync>();

/** Open (or reuse a cached) DatabaseSync for the BI store.
 *  Returns null if node:sqlite is unavailable. */
export function openBiDb(dir?: string): import("node:sqlite").DatabaseSync | null {
  const dbDir = dir ?? resolveBiDbDir();
  const cached = DB_CACHE.get(dbDir);
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
    fs.mkdirSync(dbDir, { recursive: true });
  } catch {
    // ignore — dir may already exist
  }
  const dbPath = path.join(dbDir, "bi.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = OFF");
  ensureBiDbSchema(db);
  DB_CACHE.set(dbDir, db);
  return db;
}

/** Clear all cached DB handles (used in tests to reset state between runs). */
export function clearBiDbCacheForTest(): void {
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

/** Initialize the BI council schema. Idempotent — safe to call on every open. */
export function ensureBiDbSchema(db: import("node:sqlite").DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // sync_data: raw records from business tools, deduped by source+source_id.
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_data (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      source       TEXT    NOT NULL,
      data_type    TEXT    NOT NULL,
      content_json TEXT    NOT NULL,
      synced_at    INTEGER NOT NULL,
      source_id    TEXT    NOT NULL,
      UNIQUE(source, source_id)
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sync_data_source    ON sync_data(source);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sync_data_synced_at ON sync_data(synced_at);`);

  // expert_analyses: per-run LLM outputs from each persona.
  db.exec(`
    CREATE TABLE IF NOT EXISTS expert_analyses (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id        TEXT    NOT NULL,
      expert_name   TEXT    NOT NULL,
      analysis_text TEXT    NOT NULL,
      signal_count  INTEGER NOT NULL DEFAULT 0,
      model         TEXT    NOT NULL,
      created_at    INTEGER NOT NULL
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_expert_analyses_run_id ON expert_analyses(run_id);`);

  // recommendations: synthesized and ranked.
  db.exec(`
    CREATE TABLE IF NOT EXISTS recommendations (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id               TEXT    NOT NULL,
      rank                 INTEGER NOT NULL,
      title                TEXT    NOT NULL,
      rationale            TEXT    NOT NULL,
      priority             TEXT    NOT NULL CHECK(priority IN ('high','medium','low')),
      contributing_domains TEXT    NOT NULL,
      created_at           INTEGER NOT NULL
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_recommendations_run_id   ON recommendations(run_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_recommendations_priority ON recommendations(priority);`);

  // recommendation_feedback: user accept/reject/defer decisions.
  db.exec(`
    CREATE TABLE IF NOT EXISTS recommendation_feedback (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      recommendation_id INTEGER NOT NULL REFERENCES recommendations(id),
      feedback_type     TEXT    NOT NULL CHECK(feedback_type IN ('accept','reject','defer')),
      notes             TEXT,
      created_at        INTEGER NOT NULL,
      UNIQUE(recommendation_id)
    );
  `);

  db.exec(`INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('schema_version', '1');`);
}

// ============================================================================
// sync_data CRUD
// ============================================================================

export type SyncRecord = {
  source: string;
  dataType: string;
  contentJson: string;
  sourceId: string;
};

export type SyncDataRow = {
  id: number;
  source: string;
  data_type: string;
  content_json: string;
  synced_at: number;
  source_id: string;
};

/** Upsert a synced record. Re-syncing the same source_id updates the content. */
export function upsertSyncData(db: import("node:sqlite").DatabaseSync, rec: SyncRecord): void {
  const now = Date.now();
  db.prepare(`
    INSERT INTO sync_data (source, data_type, content_json, synced_at, source_id)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(source, source_id) DO UPDATE SET
      data_type    = excluded.data_type,
      content_json = excluded.content_json,
      synced_at    = excluded.synced_at
  `).run(rec.source, rec.dataType, rec.contentJson, now, rec.sourceId);
}

/** Query sync_data records, optionally filtered by source and/or time window. */
export function querySyncData(
  db: import("node:sqlite").DatabaseSync,
  opts: { source?: string; since?: number; limit?: number } = {},
): SyncDataRow[] {
  const { source, since, limit = 500 } = opts;
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (source) {
    conditions.push("source = ?");
    params.push(source);
  }
  if (since !== undefined) {
    conditions.push("synced_at >= ?");
    params.push(since);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return db
    .prepare(`SELECT * FROM sync_data ${where} ORDER BY synced_at DESC LIMIT ?`)
    .all(...params, limit) as SyncDataRow[];
}

// ============================================================================
// expert_analyses CRUD
// ============================================================================

export type ExpertAnalysisRow = {
  id: number;
  run_id: string;
  expert_name: string;
  analysis_text: string;
  signal_count: number;
  model: string;
  created_at: number;
};

/** Insert an expert analysis record. Returns the new row id. */
export function insertExpertAnalysis(
  db: import("node:sqlite").DatabaseSync,
  row: Omit<ExpertAnalysisRow, "id">,
): number {
  const result = db
    .prepare(`
      INSERT INTO expert_analyses (run_id, expert_name, analysis_text, signal_count, model, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    .run(
      row.run_id,
      row.expert_name,
      row.analysis_text,
      row.signal_count,
      row.model,
      row.created_at,
    );
  return Number(result.lastInsertRowid);
}

/** Query expert analyses for a run. */
export function queryExpertAnalyses(
  db: import("node:sqlite").DatabaseSync,
  opts: { runId?: string; limit?: number } = {},
): ExpertAnalysisRow[] {
  const { runId, limit = 50 } = opts;
  if (runId) {
    return db
      .prepare(`SELECT * FROM expert_analyses WHERE run_id = ? ORDER BY expert_name ASC LIMIT ?`)
      .all(runId, limit) as ExpertAnalysisRow[];
  }
  return db
    .prepare(`SELECT * FROM expert_analyses ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as ExpertAnalysisRow[];
}

// ============================================================================
// recommendations CRUD
// ============================================================================

export type RecommendationRow = {
  id: number;
  run_id: string;
  rank: number;
  title: string;
  rationale: string;
  priority: string;
  contributing_domains: string; // JSON array string
  created_at: number;
};

/** Insert a recommendation. Returns the new row id. */
export function insertRecommendation(
  db: import("node:sqlite").DatabaseSync,
  row: Omit<RecommendationRow, "id">,
): number {
  const result = db
    .prepare(`
      INSERT INTO recommendations (run_id, rank, title, rationale, priority, contributing_domains, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      row.run_id,
      row.rank,
      row.title,
      row.rationale,
      row.priority,
      row.contributing_domains,
      row.created_at,
    );
  return Number(result.lastInsertRowid);
}

/** Query recommendations, optionally filtered by run_id and/or priority. */
export function queryRecommendations(
  db: import("node:sqlite").DatabaseSync,
  opts: { runId?: string; priority?: string; limit?: number } = {},
): RecommendationRow[] {
  const { runId, priority, limit = 20 } = opts;
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (runId) {
    conditions.push("run_id = ?");
    params.push(runId);
  }
  if (priority) {
    conditions.push("priority = ?");
    params.push(priority);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return db
    .prepare(`SELECT * FROM recommendations ${where} ORDER BY rank ASC LIMIT ?`)
    .all(...params, limit) as RecommendationRow[];
}

/** Return the run_id of the most recent council run, or null if none. */
export function getLastRunId(db: import("node:sqlite").DatabaseSync): string | null {
  const row = db
    .prepare(`SELECT run_id FROM recommendations ORDER BY created_at DESC LIMIT 1`)
    .get() as { run_id: string } | undefined;
  return row?.run_id ?? null;
}

// ============================================================================
// recommendation_feedback CRUD
// ============================================================================

export type FeedbackRow = {
  id: number;
  recommendation_id: number;
  feedback_type: string;
  notes: string | null;
  created_at: number;
};

/** Upsert feedback for a recommendation. Preserves created_at on update. */
export function upsertFeedback(
  db: import("node:sqlite").DatabaseSync,
  opts: {
    recommendationId: number;
    feedbackType: "accept" | "reject" | "defer";
    notes?: string;
  },
): void {
  const now = Date.now();
  db.prepare(`
    INSERT INTO recommendation_feedback (recommendation_id, feedback_type, notes, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(recommendation_id) DO UPDATE SET
      feedback_type = excluded.feedback_type,
      notes         = excluded.notes
  `).run(opts.recommendationId, opts.feedbackType, opts.notes ?? null, now);
}

/** Query feedback for a specific recommendation, or null if none recorded. */
export function queryFeedback(
  db: import("node:sqlite").DatabaseSync,
  recommendationId: number,
): FeedbackRow | null {
  return (
    (db
      .prepare(`SELECT * FROM recommendation_feedback WHERE recommendation_id = ?`)
      .get(recommendationId) as FeedbackRow | undefined) ?? null
  );
}

/** Query all feedback, newest first. */
export function queryAllFeedback(
  db: import("node:sqlite").DatabaseSync,
  opts: { limit?: number } = {},
): FeedbackRow[] {
  const { limit = 50 } = opts;
  return db
    .prepare(`SELECT * FROM recommendation_feedback ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as FeedbackRow[];
}
