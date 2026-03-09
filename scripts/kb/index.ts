#!/usr/bin/env node
/**
 * OpenClaw KB — RAG knowledge base CLI.
 *
 * Usage:
 *   bun scripts/kb/index.ts ingest <url> [--tags tag1,tag2] [--crosspost]
 *   bun scripts/kb/index.ts query  "<text>" [--tags t1,t2] [--source-type article] [--limit 10] [--threshold 0.7] [--from 2024-01-01] [--to 2024-12-31]
 *   bun scripts/kb/index.ts list   [--source-type article] [--tags t1,t2] [--limit 50]
 *   bun scripts/kb/index.ts delete <source-id>
 *   bun scripts/kb/index.ts bulk   <urls-file> [--tags tag1,tag2] [--crosspost]
 *   bun scripts/kb/index.ts status
 *
 * Setup:
 *   pnpm add -D @xenova/transformers   # local embedding model (~22 MB download on first use)
 *   export OPENCLAW_KB_SLACK_WEBHOOK=https://hooks.slack.com/... (optional)
 *   export OPENCLAW_KB_SEMANTIC_SCAN=1  (optional — requires ANTHROPIC_API_KEY)
 */

import { readFileSync } from "node:fs";
import { chunkText } from "./chunk.ts";
import { crosspost } from "./crosspost.ts";
import {
  openDb,
  upsertSource,
  updateChunkCount,
  deleteChunksForSource,
  insertChunk,
  deleteSource,
  listSources,
  loadAllChunksWithEmbeddings,
  getSourceById,
  getDbPath,
} from "./db.ts";
import { embed, embedBatch, cosineSimilarity } from "./embeddings.ts";
import { fetchContent } from "./fetch.ts";
import { withLock } from "./lock.ts";
import { runPreflight, assertPreflight } from "./preflight.ts";
import { validateUrlScheme, sanitizeContent, semanticScan, cleanUrl } from "./sanitize.ts";
import type { QueryOptions, SourceType } from "./types.ts";

// ── Arg parsing (no framework dependency) ────────────────────────────────────

function parseArgs(argv: string[]): {
  command: string;
  pos: string[];
  flags: Record<string, string | true>;
} {
  const [command = "", ...rest] = argv.slice(2);
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = rest[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      pos.push(arg);
    }
  }
  return { command, pos, flags };
}

function flag(flags: Record<string, string | true>, key: string): string | undefined {
  const v = flags[key];
  return typeof v === "string" ? v : undefined;
}

function die(msg: string): never {
  console.error(`[kb] Error: ${msg}`);
  process.exit(1);
}

// ── Commands ─────────────────────────────────────────────────────────────────

async function cmdIngest(
  url: string,
  opts: { tags: string[]; crosspostEnabled: boolean },
): Promise<void> {
  const { tags, crosspostEnabled } = opts;

  // Validate URL scheme.
  const schemeCheck = validateUrlScheme(url);
  if (!schemeCheck.ok) {
    die(schemeCheck.error!);
  }

  // Clean tracking params.
  const cleanedUrl = cleanUrl(url);
  if (cleanedUrl !== url) {
    console.log(`[kb] Cleaned URL: ${cleanedUrl}`);
  }

  await withLock(cleanedUrl, async () => {
    console.log(`[kb] Fetching: ${cleanedUrl} …`);
    let content;
    try {
      content = await fetchContent(cleanedUrl);
    } catch (e) {
      die(`Fetch failed: ${String(e)}`);
    }

    // Sanitize.
    const { text, summary: sanitizationSummary } = sanitizeContent(content.text);
    console.log(`[kb] Sanitization: ${sanitizationSummary}`);

    // Optional semantic scan (keeps raw content out of conversation loop).
    const scanResult = await semanticScan(text);
    if (!scanResult.safe) {
      die(`Semantic scan flagged content as unsafe: ${scanResult.reason}. Ingest aborted.`);
    }

    // Chunk.
    const chunks = chunkText(text);
    console.log(`[kb] ${chunks.length} chunk(s) from ${text.length} chars.`);

    // Store source (upsert so re-ingestion refreshes).
    const sourceId = upsertSource(cleanedUrl, content.title, content.sourceType, tags);
    deleteChunksForSource(sourceId); // clear old chunks on re-ingest

    // Embed + store chunks.
    console.log("[kb] Generating embeddings …");
    const texts = chunks.map((c) => c.content);
    const embeddings = await embedBatch(texts, (i, total) => {
      process.stdout.write(`\r[kb] Embedding ${i}/${total} …`);
    });
    process.stdout.write("\n");

    for (let i = 0; i < chunks.length; i++) {
      insertChunk(sourceId, i, chunks[i].content, embeddings[i], chunks[i].tokenCount);
    }
    updateChunkCount(sourceId, chunks.length);

    console.log(`[kb] Ingested source #${sourceId}: "${content.title}" (${chunks.length} chunks).`);

    // Cross-post summary (metadata only — not raw content).
    if (crosspostEnabled) {
      const source = getSourceById(sourceId)!;
      await crosspost({ source, chunkCount: chunks.length, sanitizationSummary });
    }
  });
}

async function cmdQuery(queryText: string, opts: QueryOptions): Promise<void> {
  const { tags, sourceType, limit = 5, threshold = 0.3, dateFrom, dateTo } = opts;

  console.log(`[kb] Embedding query …`);
  const queryVec = await embed(queryText);

  // Resolve source IDs if tag or type filter is active.
  let sourceIds: number[] | undefined;
  if (tags?.length || sourceType) {
    const filtered = listSources({ sourceType, tags });
    sourceIds = filtered.map((s) => s.id);
    if (sourceIds.length === 0) {
      console.log("[kb] No sources match the given filters.");
      return;
    }
  }

  // Load chunks with embeddings.
  const candidates = loadAllChunksWithEmbeddings({ sourceIds, dateFrom, dateTo });
  if (candidates.length === 0) {
    console.log("[kb] Knowledge base is empty (no embedded chunks found). Run `ingest` first.");
    return;
  }

  // Score and sort.
  const scored = candidates
    .map(({ chunk, source }) => ({
      source,
      chunk,
      similarity: cosineSimilarity(queryVec, chunk.embedding!),
    }))
    .filter((r) => r.similarity >= threshold)
    .toSorted((a, b) => b.similarity - a.similarity)
    .slice(0, limit);

  if (scored.length === 0) {
    console.log(`[kb] No results above similarity threshold ${threshold}.`);
    return;
  }

  console.log(`\n[kb] Top ${scored.length} result(s) for: "${queryText}"\n`);
  for (const r of scored) {
    const date = new Date(r.source.fetched_at).toISOString().split("T")[0];
    const sourceTags = r.source.tags.join(", ") || "—";
    console.log(`─── [${r.similarity.toFixed(4)}] ${r.source.title ?? r.source.url}`);
    console.log(
      `    Source #${r.source.id} | ${r.source.source_type} | ${date} | tags: ${sourceTags}`,
    );
    console.log(`    URL: ${r.source.url}`);
    console.log(
      `    Chunk ${r.chunk.chunk_index}: ${r.chunk.content.slice(0, 300).replace(/\n/g, " ")}…`,
    );
    console.log();
  }
}

function cmdList(opts: { sourceType?: SourceType; tags?: string[]; limit?: number }): void {
  const sources = listSources(opts);
  if (sources.length === 0) {
    console.log("[kb] No sources found.");
    return;
  }
  console.log(
    `\n${"ID".padEnd(6)} ${"TYPE".padEnd(10)} ${"CHUNKS".padEnd(7)} ${"DATE".padEnd(12)} TAGS | TITLE`,
  );
  console.log("─".repeat(80));
  for (const s of sources) {
    const date = new Date(s.fetched_at).toISOString().split("T")[0];
    const tags = s.tags.join(",") || "—";
    const title = (s.title ?? s.url).slice(0, 50);
    console.log(
      `${String(s.id).padEnd(6)} ${s.source_type.padEnd(10)} ${String(s.chunk_count).padEnd(7)} ${date.padEnd(12)} ${tags.padEnd(20)} | ${title}`,
    );
  }
  console.log(`\n${sources.length} source(s).`);
}

function cmdDelete(sourceId: number): void {
  const source = getSourceById(sourceId);
  if (!source) {
    die(`Source #${sourceId} not found.`);
  }
  const ok = deleteSource(sourceId);
  if (ok) {
    console.log(`[kb] Deleted source #${sourceId}: "${source.title ?? source.url}".`);
  } else {
    die(`Failed to delete source #${sourceId}.`);
  }
}

async function cmdBulk(
  filePath: string,
  opts: { tags: string[]; crosspostEnabled: boolean },
): Promise<void> {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (e) {
    die(`Cannot read file "${filePath}": ${String(e)}`);
  }

  const urls = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

  console.log(`[kb] Bulk ingest: ${urls.length} URL(s) from ${filePath}`);

  let ok = 0;
  let failed = 0;
  for (const url of urls) {
    console.log(`\n[kb] ── ${url}`);
    try {
      await cmdIngest(url, opts);
      ok++;
    } catch (e) {
      console.error(`[kb] FAILED: ${String(e)}`);
      failed++;
    }
  }
  console.log(`\n[kb] Bulk complete: ${ok} succeeded, ${failed} failed.`);
}

async function cmdStatus(): Promise<void> {
  const result = runPreflight(false);
  for (const w of result.warnings) {
    console.warn(`WARN  ${w}`);
  }
  for (const e of result.errors) {
    console.error(`ERROR ${e}`);
  }
  if (result.ok && result.warnings.length === 0) {
    console.log("[kb] All preflight checks passed.");
  }

  // Show source count if DB exists.
  try {
    openDb();
    const sources = listSources({ limit: 10000 });
    const totalChunks = sources.reduce((s, x) => s + x.chunk_count, 0);
    console.log(`[kb] Sources: ${sources.length} | Total chunks: ${totalChunks}`);
    console.log(`[kb] DB: ${getDbPath()}`);
  } catch {
    /* DB not initialised yet */
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { command, pos, flags } = parseArgs(process.argv);

  // Preflight (skip for status which does its own checks).
  if (command !== "status") {
    const preflight = runPreflight(command !== "ingest" && command !== "bulk");
    assertPreflight(preflight);
  }

  switch (command) {
    case "ingest": {
      const url = pos[0];
      if (!url) {
        die("Usage: ingest <url> [--tags tag1,tag2] [--crosspost]");
      }
      const tags =
        flag(flags, "tags")
          ?.split(",")
          .map((t) => t.trim())
          .filter(Boolean) ?? [];
      await cmdIngest(url, { tags, crosspostEnabled: "crosspost" in flags });
      break;
    }

    case "query": {
      const q = pos[0];
      if (!q) {
        die(
          'Usage: query "<text>" [--tags t1,t2] [--source-type article] [--limit 10] [--threshold 0.7] [--from 2024-01-01] [--to 2024-12-31]',
        );
      }
      const tags = flag(flags, "tags")
        ?.split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const sourceType = flag(flags, "source-type") as SourceType | undefined;
      const limit = flag(flags, "limit") ? parseInt(flag(flags, "limit")!) : 5;
      const threshold = flag(flags, "threshold") ? parseFloat(flag(flags, "threshold")!) : 0.3;
      const from = flag(flags, "from") ? Date.parse(flag(flags, "from")!) : undefined;
      const to = flag(flags, "to") ? Date.parse(flag(flags, "to")!) : undefined;
      await cmdQuery(q, { tags, sourceType, limit, threshold, dateFrom: from, dateTo: to });
      break;
    }

    case "list": {
      const sourceType = flag(flags, "source-type") as SourceType | undefined;
      const tags = flag(flags, "tags")
        ?.split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const limit = flag(flags, "limit") ? parseInt(flag(flags, "limit")!) : undefined;
      cmdList({ sourceType, tags, limit });
      break;
    }

    case "delete": {
      const id = parseInt(pos[0] ?? "");
      if (isNaN(id)) {
        die("Usage: delete <source-id>");
      }
      cmdDelete(id);
      break;
    }

    case "bulk": {
      const file = pos[0];
      if (!file) {
        die("Usage: bulk <urls-file> [--tags tag1,tag2] [--crosspost]");
      }
      const tags =
        flag(flags, "tags")
          ?.split(",")
          .map((t) => t.trim())
          .filter(Boolean) ?? [];
      await cmdBulk(file, { tags, crosspostEnabled: "crosspost" in flags });
      break;
    }

    case "status":
      await cmdStatus();
      break;

    default:
      console.log(`
OpenClaw KB — RAG knowledge base

Commands:
  ingest <url>          Ingest a URL into the KB
    --tags tag1,tag2    Add tags
    --crosspost         Post summary to Slack (requires OPENCLAW_KB_SLACK_WEBHOOK)

  query "<text>"        Semantic search
    --tags t1,t2        Filter by tag
    --source-type TYPE  Filter: article | tweet | youtube | pdf
    --limit N           Max results (default: 5)
    --threshold F       Min similarity 0–1 (default: 0.3)
    --from YYYY-MM-DD   Only sources ingested after this date
    --to   YYYY-MM-DD   Only sources ingested before this date

  list                  List all sources
    --source-type TYPE  Filter by type
    --tags t1,t2        Filter by tag
    --limit N           Max rows

  delete <id>           Delete a source (and its chunks)

  bulk <file>           Ingest URLs from a file (one per line, # = comment)
    --tags tag1,tag2    Apply tags to all
    --crosspost         Cross-post each summary

  status                Show KB health and statistics

Environment:
  OPENCLAW_KB_SLACK_WEBHOOK   Slack incoming webhook URL for cross-posting
  OPENCLAW_KB_SEMANTIC_SCAN   Set to 1 to enable model-based sanitization scan
  ANTHROPIC_API_KEY           Required when OPENCLAW_KB_SEMANTIC_SCAN=1
  OPENCLAW_KB_EMBED_MODEL     Override embedding model (default: Xenova/all-MiniLM-L6-v2)

Setup:
  pnpm add -D @xenova/transformers   # install local embedding model
`);
      process.exit(0);
  }
}

main().catch((e) => {
  console.error("[kb] Fatal:", e);
  process.exit(1);
});
