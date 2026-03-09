import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { clearLearningsDbCacheForTest, openLearningsDb } from "./learnings-store-sqlite.js";
import { createLearningsQueryTool, createLearningsRecordTool } from "./learnings-tool.js";

// Minimal config for tests.
function cfg(): OpenClawConfig {
  return { agents: { list: [{ id: "main", default: true }] } } as OpenClawConfig;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = path.join(
    os.tmpdir(),
    `learnings-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
});

afterEach(() => {
  clearLearningsDbCacheForTest();
});

// ============================================================================
// Context gating — mirrors memory-tool.context-gating.test.ts
// ============================================================================

describe("learnings tool context gating", () => {
  it("createLearningsRecordTool returns tool for direct session key", () => {
    const tool = createLearningsRecordTool({
      config: cfg(),
      agentSessionKey: "agent:main:telegram:direct:user123",
    });
    expect(tool).not.toBeNull();
    expect(tool[0]?.name).toBe("learnings_record");
  });

  it("createLearningsQueryTool returns tool for direct session key", () => {
    const tool = createLearningsQueryTool({
      config: cfg(),
      agentSessionKey: "agent:main:telegram:direct:user123",
    });
    expect(tool).not.toBeNull();
    expect(tool[0]?.name).toBe("learnings_query");
  });

  it("createLearningsRecordTool returns tool when no session key (CLI/main)", () => {
    const tool = createLearningsRecordTool({ config: cfg() });
    expect(tool).not.toBeNull();
  });

  it("createLearningsQueryTool returns tool when no session key (CLI/main)", () => {
    const tool = createLearningsQueryTool({ config: cfg() });
    expect(tool).not.toBeNull();
  });

  it("createLearningsRecordTool returns null for group session key", () => {
    const tool = createLearningsRecordTool({
      config: cfg(),
      agentSessionKey: "agent:main:telegram:group:g456",
    });
    expect(tool).toHaveLength(0);
  });

  it("createLearningsQueryTool returns null for group session key", () => {
    const tool = createLearningsQueryTool({
      config: cfg(),
      agentSessionKey: "agent:main:telegram:group:g456",
    });
    expect(tool).toHaveLength(0);
  });

  it("createLearningsRecordTool returns null for channel session key", () => {
    const tool = createLearningsRecordTool({
      config: cfg(),
      agentSessionKey: "agent:main:discord:channel:c789",
    });
    expect(tool).toHaveLength(0);
  });

  it("createLearningsQueryTool returns null for channel session key", () => {
    const tool = createLearningsQueryTool({
      config: cfg(),
      agentSessionKey: "agent:main:discord:channel:c789",
    });
    expect(tool).toHaveLength(0);
  });

  it("returns null when config is missing", () => {
    expect(createLearningsRecordTool({})).toHaveLength(0);
    expect(createLearningsQueryTool({})).toHaveLength(0);
  });
});

// ============================================================================
// SQL CRUD round-trips via the store directly
// ============================================================================

describe("learnings store CRUD", () => {
  it("records and queries a correction learning", async () => {
    const db = openLearningsDb(tmpDir);
    if (!db) {
      // node:sqlite unavailable in this runtime — skip gracefully
      return;
    }
    const { recordLearning, queryLearnings } = await import("./learnings-store-sqlite.js");
    const id = recordLearning(db, {
      category: "correction",
      content: "Always use heredoc for multi-line gh comments",
    });
    expect(id).toBeGreaterThan(0);

    const rows = queryLearnings(db, { category: "correction" });
    expect(rows.length).toBe(1);
    expect(rows[0].content).toContain("heredoc");
    expect(rows[0].category).toBe("correction");
  });

  it("upserts error patterns and increments count", async () => {
    const db = openLearningsDb(tmpDir);
    if (!db) {
      return;
    }
    const { upsertErrorPattern, queryErrorPatterns } = await import("./learnings-store-sqlite.js");
    upsertErrorPattern(db, { pattern: "ENOENT", example: "file not found" });
    upsertErrorPattern(db, { pattern: "ENOENT", example: "file not found again" });

    const rows = queryErrorPatterns(db);
    expect(rows.length).toBe(1);
    expect(rows[0].pattern).toBe("ENOENT");
    expect(rows[0].count).toBe(2);
  });

  it("adds and queries feature requests", async () => {
    const db = openLearningsDb(tmpDir);
    if (!db) {
      return;
    }
    const { addFeatureRequest, queryFeatureRequests } = await import("./learnings-store-sqlite.js");
    const id = addFeatureRequest(db, {
      title: "Auto-retry on rate limit",
      description: "Wrap API calls with exponential backoff",
    });
    expect(id).toBeGreaterThan(0);

    const rows = queryFeatureRequests(db, { status: "open" });
    expect(rows.length).toBe(1);
    expect(rows[0].title).toBe("Auto-retry on rate limit");
    expect(rows[0].status).toBe("open");
  });

  it("keyword filter on learnings", async () => {
    const db = openLearningsDb(tmpDir);
    if (!db) {
      return;
    }
    const { recordLearning, queryLearnings } = await import("./learnings-store-sqlite.js");
    recordLearning(db, { category: "insight", content: "Use bun for TypeScript scripts" });
    recordLearning(db, { category: "insight", content: "Prefer pnpm for dependency management" });

    const bun = queryLearnings(db, { keyword: "bun" });
    expect(bun.length).toBe(1);
    expect(bun[0].content).toContain("bun");
  });
});
