import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearKbDbCacheForTest, openKbDb, type KbDb } from "./db.js";
import type { KbEmbedder } from "./embed.js";
import { queryKb } from "./query.js";

let tmpDir: string;
let db: KbDb;

const NULL_EMBEDDER: KbEmbedder = {
  provider: null,
  vecAvailable: false,
  dims: null,
  async embedQuery() {
    return null;
  },
  async embedBatch(texts) {
    return texts.map(() => null);
  },
};

async function insertSource(
  db: KbDb,
  opts: {
    id?: string;
    url: string;
    title: string;
    sourceType?: string;
    tags?: string[];
    ingestedAt?: number;
  },
): Promise<string> {
  const id = opts.id ?? `src-${Math.random().toString(36).slice(2)}`;
  db.db
    .prepare(
      `INSERT OR REPLACE INTO kb_sources(id, url, title, source_type, tags, ingested_at, status)
       VALUES(?, ?, ?, ?, ?, ?, 'ok')`,
    )
    .run(
      id,
      opts.url,
      opts.title,
      opts.sourceType ?? "article",
      JSON.stringify(opts.tags ?? []),
      opts.ingestedAt ?? Date.now(),
    );
  return id;
}

async function insertChunk(db: KbDb, sourceId: string, text: string): Promise<string> {
  const id = `chk-${Math.random().toString(36).slice(2)}`;
  db.db
    .prepare(
      `INSERT INTO kb_chunks(id, source_id, chunk_idx, text, token_count) VALUES(?, ?, 0, ?, ?)`,
    )
    .run(id, sourceId, text, Math.ceil(text.length / 4));
  db.db
    .prepare(`INSERT INTO kb_chunks_fts(id, source_id, text) VALUES(?, ?, ?)`)
    .run(id, sourceId, text);
  return id;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kb-query-test-"));
  db = await openKbDb(path.join(tmpDir, "kb.db"));
});

afterEach(async () => {
  clearKbDbCacheForTest();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("queryKb (FTS mode)", () => {
  it("returns results matching query text", async () => {
    const srcId = await insertSource(db, {
      url: "https://example.com/a",
      title: "TypeScript Guide",
    });
    await insertChunk(db, srcId, "TypeScript is a strongly-typed programming language.");

    const results = await queryKb(db, NULL_EMBEDDER, "TypeScript programming");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title).toBe("TypeScript Guide");
    expect(results[0].matchMode).toBe("fts");
  });

  it("respects limit option", async () => {
    for (let i = 0; i < 5; i++) {
      const srcId = await insertSource(db, {
        url: `https://example.com/${i}`,
        title: `Doc ${i}`,
      });
      await insertChunk(db, srcId, `JavaScript tutorial number ${i} content`);
    }

    const results = await queryKb(db, NULL_EMBEDDER, "JavaScript tutorial", { limit: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("filters by source type", async () => {
    const articleId = await insertSource(db, {
      url: "https://example.com/article",
      title: "Article",
      sourceType: "article",
    });
    const howtoId = await insertSource(db, {
      url: "local:howto-1",
      title: "How-To",
      sourceType: "howto",
    });

    await insertChunk(db, articleId, "Node.js deployment on Linux");
    await insertChunk(db, howtoId, "Node.js deployment how-to guide");

    const results = await queryKb(db, NULL_EMBEDDER, "Node.js deployment", {
      sourceType: "howto",
    });

    expect(results.every((r) => r.sourceType === "howto")).toBe(true);
  });

  it("filters by tag", async () => {
    const taggedId = await insertSource(db, {
      url: "https://example.com/tagged",
      title: "Tagged Doc",
      tags: ["devops", "linux"],
    });
    const untaggedId = await insertSource(db, {
      url: "https://example.com/untagged",
      title: "Untagged Doc",
      tags: [],
    });

    await insertChunk(db, taggedId, "Deploy with systemd on Linux server");
    await insertChunk(db, untaggedId, "Deploy with systemd on Linux server");

    const results = await queryKb(db, NULL_EMBEDDER, "Deploy systemd Linux", {
      tag: "devops",
    });

    expect(results.every((r) => r.tags.includes("devops"))).toBe(true);
    expect(results.some((r) => r.sourceId === untaggedId)).toBe(false);
  });

  it("filters by since date", async () => {
    const oldTs = Date.now() - 10 * 24 * 60 * 60 * 1000; // 10 days ago
    const oldId = await insertSource(db, {
      url: "https://example.com/old",
      title: "Old Doc",
      ingestedAt: oldTs,
    });
    const newId = await insertSource(db, {
      url: "https://example.com/new",
      title: "New Doc",
      ingestedAt: Date.now(),
    });

    await insertChunk(db, oldId, "React hooks tutorial");
    await insertChunk(db, newId, "React hooks tutorial");

    const since = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000); // 5 days ago
    const results = await queryKb(db, NULL_EMBEDDER, "React hooks", { since });

    expect(results.every((r) => r.sourceId === newId)).toBe(true);
  });

  it("returns empty array for no matches", async () => {
    const results = await queryKb(db, NULL_EMBEDDER, "xyzzy nonexistent query");
    expect(results).toHaveLength(0);
  });
});
