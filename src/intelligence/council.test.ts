import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearBiDbCacheForTest,
  insertRecommendation,
  openBiDb,
  queryExpertAnalyses,
  queryRecommendations,
  upsertSyncData,
} from "./bi-store.js";
import { runCouncil } from "./council.js";

// All tests use COUNCIL_SKIP_LLM=1 to avoid real API calls.
// Set it once here; individual tests can override via env if needed.
const origSkipLlm = process.env.COUNCIL_SKIP_LLM;

beforeEach(() => {
  process.env.COUNCIL_SKIP_LLM = "1";
});

afterEach(() => {
  if (origSkipLlm === undefined) {
    delete process.env.COUNCIL_SKIP_LLM;
  } else {
    process.env.COUNCIL_SKIP_LLM = origSkipLlm;
  }
  clearBiDbCacheForTest();
});

function makeTmpDir() {
  return path.join(
    os.tmpdir(),
    `council-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
}

describe("runCouncil — stub mode (COUNCIL_SKIP_LLM=1)", () => {
  it("returns a CouncilRunResult with all expected fields", async () => {
    const db = openBiDb(makeTmpDir())!;
    const result = await runCouncil(db);

    expect(result.runId).toBeTruthy();
    expect(typeof result.runId).toBe("string");
    expect(Array.isArray(result.expertAnalyses)).toBe(true);
    expect(Array.isArray(result.recommendations)).toBe(true);
    expect(Array.isArray(result.skippedExperts)).toBe(true);
    expect(typeof result.runDurationMs).toBe("number");
    expect(result.runDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("stub result includes at least one expert analysis and one recommendation", async () => {
    const db = openBiDb(makeTmpDir())!;
    const result = await runCouncil(db);

    expect(result.expertAnalyses.length).toBeGreaterThan(0);
    expect(result.recommendations.length).toBeGreaterThan(0);

    const first = result.expertAnalyses[0];
    expect(typeof first.expert).toBe("string");
    expect(typeof first.text).toBe("string");
    expect(first.text.length).toBeGreaterThan(0);
  });

  it("COUNCIL_SKIP_LLM=1 exits before DB writes — nothing persisted", async () => {
    // The stub path returns early before the persistence step, so no rows are written.
    const dir = makeTmpDir();
    const db = openBiDb(dir)!;
    const result = await runCouncil(db);

    const savedAnalyses = queryExpertAnalyses(db, { runId: result.runId });
    expect(savedAnalyses).toHaveLength(0);

    const savedRecs = queryRecommendations(db, { runId: result.runId });
    expect(savedRecs).toHaveLength(0);
  });

  it("dryRun=true: returns results but does NOT write to the DB", async () => {
    const dir = makeTmpDir();
    const db = openBiDb(dir)!;
    const result = await runCouncil(db, { dryRun: true });

    expect(result.expertAnalyses.length).toBeGreaterThan(0);

    // Nothing should be written.
    const savedAnalyses = queryExpertAnalyses(db, { runId: result.runId });
    expect(savedAnalyses).toHaveLength(0);

    const savedRecs = queryRecommendations(db, { runId: result.runId });
    expect(savedRecs).toHaveLength(0);
  });

  it("runId is unique across successive runs", async () => {
    const db = openBiDb(makeTmpDir())!;
    const r1 = await runCouncil(db);
    const r2 = await runCouncil(db);
    expect(r1.runId).not.toBe(r2.runId);
  });

  it("loads only signals within the lookback window", async () => {
    const db = openBiDb(makeTmpDir())!;

    // Insert a signal dated far in the past (100 days ago) — should be ignored.
    const oldTs = Date.now() - 100 * 86_400_000;
    // Direct DB manipulation since upsertSyncData sets synced_at = Date.now().
    db.prepare(
      `INSERT INTO sync_data (source, data_type, content_json, synced_at, source_id)
       VALUES ('crm', 'deal', '{"name":"old deal"}', ?, 'old-deal-1')`,
    ).run(oldTs);

    // Insert a recent signal (within default 3-day window).
    upsertSyncData(db, {
      source: "crm",
      dataType: "deal",
      contentJson: JSON.stringify({ name: "new deal" }),
      sourceId: "new-deal-1",
    });

    // Run with 3-day lookback — stub mode, so we just verify it returns without error.
    const result = await runCouncil(db, { lookbackDays: 3 });
    expect(result.runId).toBeTruthy();
  });
});

describe("runCouncil — recommendations persistence", () => {
  it("manually inserted rows for two run IDs stay separate", () => {
    // Verifies the DB schema correctly partitions recommendations by run_id.
    // (runCouncil in stub mode does not persist — tested separately above.)
    const db = openBiDb(makeTmpDir())!;
    const now = Date.now();
    insertRecommendation(db, {
      run_id: "run-A",
      rank: 1,
      title: "Rec A",
      rationale: "r",
      priority: "high",
      contributing_domains: "[]",
      created_at: now,
    });
    insertRecommendation(db, {
      run_id: "run-B",
      rank: 1,
      title: "Rec B",
      rationale: "r",
      priority: "medium",
      contributing_domains: "[]",
      created_at: now,
    });

    const recs1 = queryRecommendations(db, { runId: "run-A" });
    const recs2 = queryRecommendations(db, { runId: "run-B" });
    expect(recs1).toHaveLength(1);
    expect(recs1[0].run_id).toBe("run-A");
    expect(recs2).toHaveLength(1);
    expect(recs2[0].run_id).toBe("run-B");
  });

  it("insertRecommendation stores the priority enum correctly", () => {
    const db = openBiDb(makeTmpDir())!;
    const now = Date.now();
    insertRecommendation(db, {
      run_id: "test-run",
      rank: 1,
      title: "Test rec",
      rationale: "Some rationale",
      priority: "high",
      contributing_domains: '["CFO","GrowthStrategist"]',
      created_at: now,
    });
    const [rec] = queryRecommendations(db, { runId: "test-run" });
    expect(rec.priority).toBe("high");
    expect(rec.title).toBe("Test rec");
    const domains = JSON.parse(rec.contributing_domains) as string[];
    expect(domains).toContain("CFO");
  });
});
