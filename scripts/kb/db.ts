import { mkdirSync } from "node:fs";
import { join } from "node:path";
/**
 * SQLite database for the knowledge base.
 * Uses Node 22+ built-in node:sqlite (same pattern as src/config/sessions/store-sqlite.ts).
 */
import { DatabaseSync } from "node:sqlite";
import type { Source, Chunk, SourceType } from "./types.ts";

const KB_DIR = join(process.env.HOME ?? "/tmp", ".openclaw", "kb");
const DB_PATH = join(KB_DIR, "knowledge.db");

let _db: DatabaseSync | null = null;

export function getKbDir(): string {
  return KB_DIR;
}

export function getDbPath(): string {
  return DB_PATH;
}

export function openDb(): DatabaseSync {
  if (_db) {
    return _db;
  }
  mkdirSync(KB_DIR, { recursive: true });
  _db = new DatabaseSync(DB_PATH);
  initSchema(_db);
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

function initSchema(db: DatabaseSync): void {
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;

    CREATE TABLE IF NOT EXISTS sources (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      url         TEXT    UNIQUE NOT NULL,
      title       TEXT,
      source_type TEXT    NOT NULL DEFAULT 'unknown',
      tags        TEXT    NOT NULL DEFAULT '[]',
      fetched_at  INTEGER NOT NULL,
      chunk_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id   INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      content     TEXT    NOT NULL,
      embedding   BLOB,
      token_count INTEGER NOT NULL DEFAULT 0,
      UNIQUE(source_id, chunk_index)
    );

    CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source_id);
    CREATE INDEX IF NOT EXISTS idx_sources_type  ON sources(source_type);
    CREATE INDEX IF NOT EXISTS idx_sources_time  ON sources(fetched_at);
  `);
}

// ── Sources ──────────────────────────────────────────────────────────────────

export function upsertSource(
  url: string,
  title: string | null,
  sourceType: SourceType,
  tags: string[],
): number {
  const db = openDb();
  const now = Date.now();
  const tagsJson = JSON.stringify(tags);

  const stmt = db.prepare(`
    INSERT INTO sources (url, title, source_type, tags, fetched_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(url) DO UPDATE SET
      title       = excluded.title,
      source_type = excluded.source_type,
      tags        = excluded.tags,
      fetched_at  = excluded.fetched_at,
      chunk_count = 0
    RETURNING id
  `);
  const row = stmt.get(url, title, sourceType, tagsJson, now) as unknown as { id: number };
  return row.id;
}

export function updateChunkCount(sourceId: number, count: number): void {
  const db = openDb();
  db.prepare("UPDATE sources SET chunk_count = ? WHERE id = ?").run(count, sourceId);
}

export function deleteSource(sourceId: number): boolean {
  const db = openDb();
  const info = db.prepare("DELETE FROM sources WHERE id = ?").run(sourceId) as unknown as {
    changes: number;
  };
  return info.changes > 0;
}

export function getSourceById(id: number): Source | null {
  const db = openDb();
  const row = db.prepare("SELECT * FROM sources WHERE id = ?").get(id) as unknown as
    | RawSource
    | undefined;
  return row ? parseSource(row) : null;
}

export function listSources(
  opts: {
    sourceType?: SourceType;
    tags?: string[];
    limit?: number;
  } = {},
): Source[] {
  const db = openDb();
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (opts.sourceType) {
    conditions.push("source_type = ?");
    params.push(opts.sourceType);
  }

  let sql = `SELECT * FROM sources${conditions.length ? " WHERE " + conditions.join(" AND ") : ""} ORDER BY fetched_at DESC`;
  if (opts.limit) {
    sql += ` LIMIT ?`;
    params.push(opts.limit);
  }

  const rows = db.prepare(sql).all(...params) as unknown as RawSource[];
  let sources = rows.map(parseSource);

  // Tag filter in JS (stored as JSON array, harder to query portably in SQL).
  if (opts.tags && opts.tags.length > 0) {
    sources = sources.filter((s) => opts.tags!.some((t) => s.tags.includes(t)));
  }

  return sources;
}

// ── Chunks ───────────────────────────────────────────────────────────────────

export function deleteChunksForSource(sourceId: number): void {
  const db = openDb();
  db.prepare("DELETE FROM chunks WHERE source_id = ?").run(sourceId);
}

export function insertChunk(
  sourceId: number,
  chunkIndex: number,
  content: string,
  embedding: Float32Array | null,
  tokenCount: number,
): void {
  const db = openDb();
  const embBlob = embedding ? Buffer.from(embedding.buffer) : null;
  db.prepare(`
    INSERT INTO chunks (source_id, chunk_index, content, embedding, token_count)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(source_id, chunk_index) DO UPDATE SET
      content     = excluded.content,
      embedding   = excluded.embedding,
      token_count = excluded.token_count
  `).run(sourceId, chunkIndex, content, embBlob, tokenCount);
}

export interface RawChunkRow {
  id: number;
  source_id: number;
  chunk_index: number;
  content: string;
  embedding: Buffer | null;
  token_count: number;
}

/** Load all chunks that have embeddings, for similarity search. */
export function loadAllChunksWithEmbeddings(
  opts: {
    sourceIds?: number[];
    dateFrom?: number;
    dateTo?: number;
  } = {},
): Array<{ chunk: Chunk; source: Source }> {
  const db = openDb();
  const conditions = ["c.embedding IS NOT NULL"];
  const params: (number | string)[] = [];

  if (opts.sourceIds && opts.sourceIds.length > 0) {
    conditions.push(`c.source_id IN (${opts.sourceIds.map(() => "?").join(",")})`);
    params.push(...opts.sourceIds);
  }
  if (opts.dateFrom) {
    conditions.push("s.fetched_at >= ?");
    params.push(opts.dateFrom);
  }
  if (opts.dateTo) {
    conditions.push("s.fetched_at <= ?");
    params.push(opts.dateTo);
  }

  const sql = `
    SELECT c.id, c.source_id, c.chunk_index, c.content, c.embedding, c.token_count,
           s.url, s.title, s.source_type, s.tags, s.fetched_at, s.chunk_count
    FROM chunks c
    JOIN sources s ON s.id = c.source_id
    WHERE ${conditions.join(" AND ")}
  `;

  const rows = db.prepare(sql).all(...params) as unknown as Array<
    RawChunkRow & {
      url: string;
      title: string | null;
      source_type: string;
      tags: string;
      fetched_at: number;
      chunk_count: number;
    }
  >;

  return rows.map((row) => ({
    chunk: {
      id: row.id,
      source_id: row.source_id,
      chunk_index: row.chunk_index,
      content: row.content,
      embedding: row.embedding ? new Float32Array(row.embedding.buffer) : null,
      token_count: row.token_count,
    },
    source: parseSource({
      id: row.source_id,
      url: row.url,
      title: row.title,
      source_type: row.source_type,
      tags: row.tags,
      fetched_at: row.fetched_at,
      chunk_count: row.chunk_count,
    }),
  }));
}

// ── Helpers ──────────────────────────────────────────────────────────────────

interface RawSource {
  id: number;
  url: string;
  title: string | null;
  source_type: string;
  tags: string;
  fetched_at: number;
  chunk_count: number;
}

function parseSource(row: RawSource): Source {
  let tags: string[] = [];
  try {
    tags = JSON.parse(row.tags);
  } catch {
    /* keep empty */
  }
  return {
    id: row.id,
    url: row.url,
    title: row.title ?? null,
    source_type: row.source_type as SourceType,
    tags,
    fetched_at: row.fetched_at,
    chunk_count: row.chunk_count,
  };
}
