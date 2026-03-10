import type { KbDb } from "./db.js";
import type { KbEmbedder } from "./embed.js";
import type { SourceType } from "./fetch.js";

export type QueryOptions = {
  tag?: string;
  sourceType?: SourceType;
  since?: Date;
  /** Maximum results to return. Default: 10. */
  limit?: number;
  /** Minimum similarity score (0–1). Default: 0.7. */
  threshold?: number;
};

export type QueryResult = {
  chunkId: string;
  sourceId: string;
  url: string;
  title: string;
  sourceType: SourceType;
  tags: string[];
  text: string;
  /** Cosine similarity (0–1) for vector results; BM25-derived score for FTS results. */
  score: number;
  matchMode: "vector" | "fts";
};

type SourceRow = {
  id: string;
  url: string;
  title: string;
  source_type: string;
  tags: string;
};

type ChunkRow = {
  id: string;
  source_id: string;
  text: string;
};

type VecRow = {
  id: string;
  distance: number;
};

type FtsRow = {
  id: string;
  source_id: string;
  text: string;
  rank: number;
};

/**
 * Query the knowledge base.
 * Uses vector search when available, falls back to FTS otherwise.
 */
export async function queryKb(
  db: KbDb,
  embedder: KbEmbedder,
  queryText: string,
  opts?: QueryOptions,
): Promise<QueryResult[]> {
  const limit = opts?.limit ?? 10;
  const threshold = opts?.threshold ?? 0.7;

  if (embedder.vecAvailable && embedder.dims) {
    const embedding = await embedder.embedQuery(queryText);
    if (embedding) {
      return vectorSearch(db, embedding, queryText, { ...opts, limit, threshold });
    }
  }

  return ftsSearch(db, queryText, { ...opts, limit, threshold });
}

async function vectorSearch(
  db: KbDb,
  embedding: number[],
  queryText: string,
  opts: Required<Pick<QueryOptions, "limit" | "threshold">> & QueryOptions,
): Promise<QueryResult[]> {
  // Fetch top candidates from vec0 (returns more than limit, we filter by threshold).
  const candidates = opts.limit * 4;
  const vecRows = db.db
    .prepare(
      `SELECT v.id, v.distance
       FROM kb_chunks_vec v
       WHERE embedding MATCH ?
       ORDER BY distance
       LIMIT ?`,
    )
    .all(JSON.stringify(embedding), candidates) as VecRow[];

  if (vecRows.length === 0) {
    // No vector results — fall back to FTS.
    return ftsSearch(db, queryText, opts);
  }

  // Convert L2 distance to similarity score in [0, 1].
  // For normalized vectors: similarity = 1 - (distance² / 2).
  const scoredIds = vecRows
    .map((r) => ({ id: r.id, score: Math.max(0, 1 - (r.distance * r.distance) / 2) }))
    .filter((r) => r.score >= opts.threshold);

  if (scoredIds.length === 0) {
    return [];
  }

  const chunkIds = scoredIds.map((r) => r.id).slice(0, opts.limit);
  const placeholders = chunkIds.map(() => "?").join(",");

  const chunks = db.db
    .prepare(
      `SELECT c.id, c.source_id, c.text
       FROM kb_chunks c
       WHERE c.id IN (${placeholders})`,
    )
    .all(...chunkIds) as ChunkRow[];

  return enrichResults(db, chunks, scoredIds, "vector", opts);
}

async function ftsSearch(
  db: KbDb,
  queryText: string,
  opts: Required<Pick<QueryOptions, "limit" | "threshold">> & QueryOptions,
): Promise<QueryResult[]> {
  // Strip FTS5 special characters (punctuation, operators) to plain terms.
  const escapedQuery = queryText.replace(/[^a-zA-Z0-9\s]/g, " ").trim();
  if (!escapedQuery) {
    return [];
  }

  const rows = db.db
    .prepare(
      `SELECT f.id, f.source_id, f.text, bm25(kb_chunks_fts) AS rank
       FROM kb_chunks_fts f
       WHERE kb_chunks_fts MATCH ?
       ORDER BY rank
       LIMIT ?`,
    )
    .all(escapedQuery, opts.limit * 2) as FtsRow[];

  if (rows.length === 0) {
    return [];
  }

  // Normalize BM25 score to a 0–1 range.
  const minRank = Math.min(...rows.map((r) => r.rank));
  const maxRank = Math.max(...rows.map((r) => r.rank));
  const rangeRank = Math.abs(maxRank - minRank) || 1;

  const chunks: ChunkRow[] = rows.map((r) => ({ id: r.id, source_id: r.source_id, text: r.text }));
  const scoredIds = rows.map((r) => ({
    id: r.id,
    score: 1 - Math.abs(r.rank - minRank) / rangeRank,
  }));

  return enrichResults(db, chunks, scoredIds, "fts", opts);
}

/** Join chunk rows with source metadata and apply tag/type/date filters. */
function enrichResults(
  db: KbDb,
  chunks: ChunkRow[],
  scoredIds: Array<{ id: string; score: number }>,
  matchMode: "vector" | "fts",
  opts: Required<Pick<QueryOptions, "limit" | "threshold">> & QueryOptions,
): QueryResult[] {
  if (chunks.length === 0) {
    return [];
  }

  const scoreMap = new Map(scoredIds.map((r) => [r.id, r.score]));
  const sourceIds = [...new Set(chunks.map((c) => c.source_id))];
  const placeholders = sourceIds.map(() => "?").join(",");

  const sources = db.db
    .prepare(
      `SELECT id, url, title, source_type, tags
       FROM kb_sources
       WHERE id IN (${placeholders})
         AND status = 'ok'
       `,
    )
    .all(...sourceIds) as SourceRow[];

  const sourceMap = new Map(sources.map((s) => [s.id, s]));

  const results: QueryResult[] = [];
  for (const chunk of chunks) {
    const source = sourceMap.get(chunk.source_id);
    if (!source) {
      continue;
    }

    // Apply source_type filter.
    if (opts.sourceType && source.source_type !== opts.sourceType) {
      continue;
    }

    // Apply tag filter.
    if (opts.tag) {
      const tags: string[] = JSON.parse(source.tags || "[]") as string[];
      if (!tags.includes(opts.tag)) {
        continue;
      }
    }

    const score = scoreMap.get(chunk.id) ?? 0;
    results.push({
      chunkId: chunk.id,
      sourceId: source.id,
      url: source.url,
      title: source.title,
      sourceType: source.source_type as SourceType,
      tags: JSON.parse(source.tags || "[]") as string[],
      text: chunk.text,
      score,
      matchMode,
    });
  }

  // Apply `since` date filter (need source ingested_at — fetch separately if needed).
  let filtered = results;
  if (opts.since) {
    const sinceMs = opts.since.getTime();
    const sourceIds2 = [...new Set(results.map((r) => r.sourceId))];
    if (sourceIds2.length > 0) {
      const ph2 = sourceIds2.map(() => "?").join(",");
      const ingestedRows = db.db
        .prepare(`SELECT id, ingested_at FROM kb_sources WHERE id IN (${ph2})`)
        .all(...sourceIds2) as { id: string; ingested_at: number }[];
      const ingestedMap = new Map(ingestedRows.map((r) => [r.id, r.ingested_at]));
      filtered = results.filter((r) => {
        const ts = ingestedMap.get(r.sourceId) ?? 0;
        return ts >= sinceMs;
      });
    }
  }

  return filtered.sort((a, b) => b.score - a.score).slice(0, opts.limit);
}
