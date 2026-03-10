import { randomUUID } from "node:crypto";
import path from "node:path";
import { withFileLock, type FileLockOptions } from "openclaw/plugin-sdk/knowledge-base";
import { chunkText } from "./chunk.js";
import { ensureVecTable, resolveLockPath, type KbDb } from "./db.js";
import type { KbEmbedder } from "./embed.js";
import { fetchSource, validateUrlScheme, type SourceType } from "./fetch.js";
import { sanitizeContent } from "./sanitize.js";

export type IngestOptions = {
  tags?: string[];
  dryRun?: boolean;
  crossPost?: string;
  /** For batch ingest: max concurrent ingestions. Default: 3. */
  concurrency?: number;
};

export type IngestResult = {
  sourceId: string;
  url: string;
  title: string;
  sourceType: SourceType;
  chunksWritten: number;
  /** True if the URL was already in the KB (no-op). */
  skipped: boolean;
  dryRun: boolean;
};

export type ManualAddOptions = {
  type: "howto" | "prompt" | "issue";
  title: string;
  text: string;
  tags?: string[];
  dryRun?: boolean;
};

const LOCK_OPTIONS: FileLockOptions = {
  retries: {
    retries: 5,
    factor: 2,
    minTimeout: 200,
    maxTimeout: 5000,
    randomize: true,
  },
  stale: 30_000,
};

/**
 * Ingest a single URL into the knowledge base.
 * Validates scheme, checks for duplicates, fetches, sanitizes, chunks, embeds, stores.
 */
export async function ingestUrl(
  url: string,
  db: KbDb,
  embedder: KbEmbedder,
  opts?: IngestOptions,
): Promise<IngestResult> {
  validateUrlScheme(url);

  // Check for existing OK source.
  const existing = db.db
    .prepare("SELECT id, source_type, title FROM kb_sources WHERE url = ? AND status = 'ok'")
    .get(url) as { id: string; source_type: string; title: string } | undefined;

  if (existing) {
    return {
      sourceId: existing.id,
      url,
      title: existing.title,
      sourceType: existing.source_type as SourceType,
      chunksWritten: 0,
      skipped: true,
      dryRun: opts?.dryRun ?? false,
    };
  }

  const tags = opts?.tags ?? [];
  const lockPath = resolveLockPath(db.dbPath);

  return withFileLock(lockPath, LOCK_OPTIONS, async () => {
    // Insert pending row (idempotent on duplicate URL).
    const sourceId = randomUUID();
    db.db
      .prepare(
        `INSERT OR IGNORE INTO kb_sources(id, url, title, source_type, tags, ingested_at, status)
         VALUES(?, ?, '', 'article', ?, ?, 'pending')`,
      )
      .run(sourceId, url, JSON.stringify(tags), Date.now());

    // Fetch and process content.
    const fetchResult = await fetchSource(url);
    const { text: sanitizedText } = sanitizeContent(fetchResult.text);
    const chunks = chunkText(sanitizedText);

    if (opts?.dryRun) {
      // Roll back the pending row.
      db.db.prepare("DELETE FROM kb_sources WHERE id = ? AND status = 'pending'").run(sourceId);
      return {
        sourceId,
        url,
        title: fetchResult.title,
        sourceType: fetchResult.sourceType,
        chunksWritten: chunks.length,
        skipped: false,
        dryRun: true,
      };
    }

    // Update source_type and title from fetched content.
    db.db
      .prepare("UPDATE kb_sources SET source_type = ?, title = ? WHERE id = ?")
      .run(fetchResult.sourceType, fetchResult.title, sourceId);

    // Ensure vec0 table if embedding is available.
    if (embedder.vecAvailable && embedder.dims) {
      ensureVecTable(db.db, embedder.dims);
    }

    // Generate embeddings in batch.
    const embeddings = embedder.vecAvailable
      ? await embedder.embedBatch(chunks.map((c) => c.text))
      : chunks.map(() => null);

    // Store chunks in a single transaction.
    storeChunks(db, sourceId, chunks, embeddings, embedder.vecAvailable && embedder.dims !== null);

    // Mark source as OK.
    db.db.prepare("UPDATE kb_sources SET status = 'ok' WHERE id = ?").run(sourceId);

    if (opts?.crossPost) {
      await postCrossPost(opts.crossPost, url, fetchResult.title, sanitizedText, tags);
    }

    return {
      sourceId,
      url,
      title: fetchResult.title,
      sourceType: fetchResult.sourceType,
      chunksWritten: chunks.length,
      skipped: false,
      dryRun: false,
    };
  });
}

/**
 * Add a manually-entered text entry (how-to, prompt, or known issue).
 * No URL fetch — text is provided directly.
 */
export async function addManual(
  db: KbDb,
  embedder: KbEmbedder,
  opts: ManualAddOptions,
): Promise<IngestResult> {
  const { text: sanitizedText } = sanitizeContent(opts.text);
  const chunks = chunkText(sanitizedText);
  const localUrl = `local:${randomUUID()}`;
  const tags = opts.tags ?? [];
  const lockPath = resolveLockPath(db.dbPath);

  return withFileLock(lockPath, LOCK_OPTIONS, async () => {
    if (opts.dryRun) {
      return {
        sourceId: "dry-run",
        url: localUrl,
        title: opts.title,
        sourceType: opts.type,
        chunksWritten: chunks.length,
        skipped: false,
        dryRun: true,
      };
    }

    const sourceId = randomUUID();

    db.db
      .prepare(
        `INSERT INTO kb_sources(id, url, title, source_type, tags, ingested_at, status)
         VALUES(?, ?, ?, ?, ?, ?, 'ok')`,
      )
      .run(sourceId, localUrl, opts.title, opts.type, JSON.stringify(tags), Date.now());

    if (embedder.vecAvailable && embedder.dims) {
      ensureVecTable(db.db, embedder.dims);
    }

    const embeddings = embedder.vecAvailable
      ? await embedder.embedBatch(chunks.map((c) => c.text))
      : chunks.map(() => null);

    storeChunks(db, sourceId, chunks, embeddings, embedder.vecAvailable && embedder.dims !== null);

    return {
      sourceId,
      url: localUrl,
      title: opts.title,
      sourceType: opts.type,
      chunksWritten: chunks.length,
      skipped: false,
      dryRun: false,
    };
  });
}

/**
 * Ingest multiple URLs concurrently with a configurable concurrency limit.
 */
export async function ingestBatch(
  urls: string[],
  db: KbDb,
  embedder: KbEmbedder,
  opts?: IngestOptions,
  onProgress?: (completed: number, total: number, url: string) => void,
): Promise<IngestResult[]> {
  const concurrency = opts?.concurrency ?? 3;
  const results: IngestResult[] = [];
  let completed = 0;

  // Process in sliding-window batches.
  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(
      batch.map((url) => ingestUrl(url, db, embedder, opts)),
    );

    for (let j = 0; j < batchResults.length; j++) {
      const r = batchResults[j];
      completed++;
      const url = batch[j] ?? "";
      if (r.status === "fulfilled") {
        results.push(r.value);
      } else {
        // Report failure but continue with remaining URLs.
        results.push({
          sourceId: "",
          url,
          title: "",
          sourceType: "article",
          chunksWritten: 0,
          skipped: false,
          dryRun: opts?.dryRun ?? false,
        });
        process.stderr.write(`KB ingest error for ${url}: ${String(r.reason)}\n`);
      }
      onProgress?.(completed, urls.length, url);
    }
  }

  return results;
}

// ============================================================================
// Internal helpers
// ============================================================================

function storeChunks(
  db: KbDb,
  sourceId: string,
  chunks: ReturnType<typeof chunkText>,
  embeddings: Array<number[] | null>,
  storeVec: boolean,
): void {
  // Single transaction for all chunk writes.
  const insertChunk = db.db.prepare(
    `INSERT OR REPLACE INTO kb_chunks(id, source_id, chunk_idx, text, token_count)
     VALUES(?, ?, ?, ?, ?)`,
  );
  const insertFts = db.db.prepare(`INSERT INTO kb_chunks_fts(id, source_id, text) VALUES(?, ?, ?)`);
  const insertVec = storeVec
    ? db.db.prepare(`INSERT OR REPLACE INTO kb_chunks_vec(id, embedding) VALUES(?, ?)`)
    : null;

  db.db.prepare("BEGIN").run();
  try {
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const chunkId = randomUUID();
      const embedding = embeddings[i];

      insertChunk.run(chunkId, sourceId, chunk.chunkIdx, chunk.text, chunk.tokenCount);
      insertFts.run(chunkId, sourceId, chunk.text);
      if (insertVec && embedding) {
        insertVec.run(chunkId, JSON.stringify(embedding));
      }
    }
    db.db.prepare("COMMIT").run();
  } catch (err) {
    db.db.prepare("ROLLBACK").run();
    throw err;
  }
}

async function postCrossPost(
  channel: string,
  url: string,
  title: string,
  text: string,
  tags: string[],
): Promise<void> {
  const { postSummary } = await import("./crosspost.js");
  await postSummary({ channel, sourceUrl: url, title, text, tags });
}
