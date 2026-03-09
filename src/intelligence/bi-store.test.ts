import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearBiDbCacheForTest,
  insertExpertAnalysis,
  insertRecommendation,
  openBiDb,
  queryExpertAnalyses,
  queryFeedback,
  queryRecommendations,
  querySyncData,
  upsertFeedback,
  upsertSyncData,
  getLastRunId,
} from "./bi-store.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = path.join(
    os.tmpdir(),
    `bi-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
});

afterEach(() => {
  clearBiDbCacheForTest();
});

describe("openBiDb", () => {
  it("opens a database and returns a handle", () => {
    const db = openBiDb(tmpDir);
    expect(db).not.toBeNull();
  });

  it("returns the same handle on repeated calls (cache)", () => {
    const db1 = openBiDb(tmpDir);
    const db2 = openBiDb(tmpDir);
    expect(db1).toBe(db2);
  });
});

describe("upsertSyncData / querySyncData", () => {
  it("inserts and retrieves a sync record", () => {
    const db = openBiDb(tmpDir)!;
    upsertSyncData(db, {
      source: "crm",
      dataType: "deal",
      contentJson: JSON.stringify({ name: "ACME Corp", amount: 50000 }),
      sourceId: "deal-001",
    });
    const rows = querySyncData(db, { source: "crm" });
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("crm");
    expect(rows[0].data_type).toBe("deal");
    expect(rows[0].source_id).toBe("deal-001");
  });

  it("deduplicates on source+source_id (upsert updates content)", () => {
    const db = openBiDb(tmpDir)!;
    upsertSyncData(db, { source: "crm", dataType: "deal", contentJson: '{"v":1}', sourceId: "d1" });
    upsertSyncData(db, { source: "crm", dataType: "deal", contentJson: '{"v":2}', sourceId: "d1" });
    const rows = querySyncData(db, { source: "crm" });
    expect(rows).toHaveLength(1);
    expect(rows[0].content_json).toBe('{"v":2}');
  });

  it("filters by source", () => {
    const db = openBiDb(tmpDir)!;
    upsertSyncData(db, { source: "crm", dataType: "deal", contentJson: "{}", sourceId: "d1" });
    upsertSyncData(db, { source: "chat", dataType: "message", contentJson: "{}", sourceId: "m1" });
    expect(querySyncData(db, { source: "crm" })).toHaveLength(1);
    expect(querySyncData(db, { source: "chat" })).toHaveLength(1);
    expect(querySyncData(db)).toHaveLength(2);
  });

  it("filters by since timestamp", () => {
    const db = openBiDb(tmpDir)!;
    upsertSyncData(db, { source: "crm", dataType: "deal", contentJson: "{}", sourceId: "d1" });
    const future = Date.now() + 60_000;
    expect(querySyncData(db, { since: future })).toHaveLength(0);
    expect(querySyncData(db, { since: 0 })).toHaveLength(1);
  });
});

describe("insertExpertAnalysis / queryExpertAnalyses", () => {
  it("inserts and retrieves expert analyses", () => {
    const db = openBiDb(tmpDir)!;
    const now = Date.now();
    insertExpertAnalysis(db, {
      run_id: "run-1",
      expert_name: "GrowthStrategist",
      analysis_text: "FINDING: Strong growth in chat signals\nDETAIL: ...",
      signal_count: 12,
      model: "claude-opus-4-6",
      created_at: now,
    });
    const rows = queryExpertAnalyses(db, { runId: "run-1" });
    expect(rows).toHaveLength(1);
    expect(rows[0].expert_name).toBe("GrowthStrategist");
    expect(rows[0].signal_count).toBe(12);
  });

  it("returns rows for a specific run_id only", () => {
    const db = openBiDb(tmpDir)!;
    const now = Date.now();
    insertExpertAnalysis(db, {
      run_id: "run-1",
      expert_name: "CFO",
      analysis_text: "...",
      signal_count: 3,
      model: "claude-opus-4-6",
      created_at: now,
    });
    insertExpertAnalysis(db, {
      run_id: "run-2",
      expert_name: "CFO",
      analysis_text: "...",
      signal_count: 5,
      model: "claude-opus-4-6",
      created_at: now,
    });
    expect(queryExpertAnalyses(db, { runId: "run-1" })).toHaveLength(1);
    expect(queryExpertAnalyses(db, { runId: "run-2" })).toHaveLength(1);
  });
});

describe("insertRecommendation / queryRecommendations / getLastRunId", () => {
  it("inserts and retrieves recommendations ordered by rank", () => {
    const db = openBiDb(tmpDir)!;
    const now = Date.now();
    insertRecommendation(db, {
      run_id: "run-1",
      rank: 2,
      title: "Second",
      rationale: "r2",
      priority: "medium",
      contributing_domains: '["CFO"]',
      created_at: now,
    });
    insertRecommendation(db, {
      run_id: "run-1",
      rank: 1,
      title: "First",
      rationale: "r1",
      priority: "high",
      contributing_domains: '["Growth"]',
      created_at: now,
    });
    const rows = queryRecommendations(db, { runId: "run-1" });
    expect(rows).toHaveLength(2);
    expect(rows[0].rank).toBe(1);
    expect(rows[0].title).toBe("First");
    expect(rows[1].rank).toBe(2);
  });

  it("filters by priority", () => {
    const db = openBiDb(tmpDir)!;
    const now = Date.now();
    insertRecommendation(db, {
      run_id: "run-1",
      rank: 1,
      title: "H",
      rationale: "r",
      priority: "high",
      contributing_domains: "[]",
      created_at: now,
    });
    insertRecommendation(db, {
      run_id: "run-1",
      rank: 2,
      title: "L",
      rationale: "r",
      priority: "low",
      contributing_domains: "[]",
      created_at: now,
    });
    expect(queryRecommendations(db, { priority: "high" })).toHaveLength(1);
    expect(queryRecommendations(db, { priority: "low" })).toHaveLength(1);
  });

  it("getLastRunId returns the most recent run_id", () => {
    const db = openBiDb(tmpDir)!;
    expect(getLastRunId(db)).toBeNull();
    const now = Date.now();
    insertRecommendation(db, {
      run_id: "run-abc",
      rank: 1,
      title: "T",
      rationale: "r",
      priority: "high",
      contributing_domains: "[]",
      created_at: now,
    });
    expect(getLastRunId(db)).toBe("run-abc");
  });
});

describe("upsertFeedback / queryFeedback", () => {
  it("records feedback and retrieves it", () => {
    const db = openBiDb(tmpDir)!;
    const now = Date.now();
    const recId = insertRecommendation(db, {
      run_id: "run-1",
      rank: 1,
      title: "T",
      rationale: "r",
      priority: "high",
      contributing_domains: "[]",
      created_at: now,
    });
    upsertFeedback(db, { recommendationId: recId, feedbackType: "accept", notes: "great idea" });
    const fb = queryFeedback(db, recId);
    expect(fb).not.toBeNull();
    expect(fb?.feedback_type).toBe("accept");
    expect(fb?.notes).toBe("great idea");
  });

  it("upsert updates feedback type without duplicating rows", () => {
    const db = openBiDb(tmpDir)!;
    const now = Date.now();
    const recId = insertRecommendation(db, {
      run_id: "run-1",
      rank: 1,
      title: "T",
      rationale: "r",
      priority: "high",
      contributing_domains: "[]",
      created_at: now,
    });
    upsertFeedback(db, { recommendationId: recId, feedbackType: "defer" });
    upsertFeedback(db, { recommendationId: recId, feedbackType: "accept", notes: "changed mind" });
    const fb = queryFeedback(db, recId);
    expect(fb?.feedback_type).toBe("accept");
    expect(fb?.notes).toBe("changed mind");
  });

  it("returns null when no feedback recorded", () => {
    const db = openBiDb(tmpDir)!;
    expect(queryFeedback(db, 9999)).toBeNull();
  });
});
