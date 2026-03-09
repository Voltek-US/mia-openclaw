import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateJsonToSqliteIfNeeded } from "./store-sqlite-migration.js";
import {
  clearSessionDbCacheForTest,
  getSessionEntry,
  getSessionCount,
  loadAllSessionsFromDb,
  openSessionDb,
} from "./store-sqlite.js";
import type { SessionEntry } from "./types.js";

function makeEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "sess-" + Math.random().toString(36).slice(2),
    updatedAt: Date.now(),
    ...overrides,
  } as SessionEntry;
}

function useTempDir() {
  let dir = "";
  let storePath = "";
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-migration-test-"));
    storePath = path.join(dir, "sessions.json");
  });
  afterEach(() => {
    clearSessionDbCacheForTest();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir: () => dir,
    storePath: () => storePath,
  };
}

function writeSessionsJson(storePath: string, store: Record<string, SessionEntry>): void {
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2), { encoding: "utf-8", mode: 0o600 });
}

describe("migrateJsonToSqliteIfNeeded", () => {
  const { dir, storePath } = useTempDir();

  it("returns skipped=false and migrated=0 when no sessions.json exists", () => {
    const db = openSessionDb(dir());
    if (!db) {
      return;
    }
    const result = migrateJsonToSqliteIfNeeded({ db, storePath: storePath() });
    expect(result).toEqual({ migrated: 0, skipped: false });
    expect(getSessionCount(db)).toBe(0);
  });

  it("imports all entries from sessions.json", () => {
    const entry1 = makeEntry({ sessionId: "s1" });
    const entry2 = makeEntry({ sessionId: "s2" });
    writeSessionsJson(storePath(), { key1: entry1, key2: entry2 });

    const db = openSessionDb(dir());
    if (!db) {
      return;
    }
    const result = migrateJsonToSqliteIfNeeded({ db, storePath: storePath() });
    expect(result.migrated).toBe(2);
    expect(result.skipped).toBe(false);
    expect(getSessionCount(db)).toBe(2);
    expect(getSessionEntry(db, "key1")?.sessionId).toBe("s1");
    expect(getSessionEntry(db, "key2")?.sessionId).toBe("s2");
  });

  it("returns skipped=true on subsequent calls (idempotent)", () => {
    writeSessionsJson(storePath(), { key1: makeEntry() });

    const db = openSessionDb(dir());
    if (!db) {
      return;
    }
    migrateJsonToSqliteIfNeeded({ db, storePath: storePath() });
    const result2 = migrateJsonToSqliteIfNeeded({ db, storePath: storePath() });
    expect(result2).toEqual({ migrated: 0, skipped: true });
    // Count should still be 1, not 2
    expect(getSessionCount(db)).toBe(1);
  });

  it("preserves all SessionEntry fields through migration", () => {
    const entry = makeEntry({
      sessionId: "s1",
      updatedAt: 12345,
      chatType: "direct",
      sessionFile: "/tmp/sessions/s1.jsonl",
    });
    writeSessionsJson(storePath(), { mykey: entry });

    const db = openSessionDb(dir());
    if (!db) {
      return;
    }
    migrateJsonToSqliteIfNeeded({ db, storePath: storePath() });

    const retrieved = getSessionEntry(db, "mykey");
    expect(retrieved?.sessionId).toBe("s1");
    expect(retrieved?.updatedAt).toBe(12345);
    expect(retrieved?.chatType).toBe("direct");
    expect(retrieved?.sessionFile).toBe("/tmp/sessions/s1.jsonl");
  });

  it("applies legacy field migrations (provider → channel) during import", () => {
    // Write a sessions.json with old-style `provider` field (pre-migration schema)
    const legacyEntry = {
      sessionId: "s1",
      updatedAt: Date.now(),
      provider: "telegram", // legacy field that should become `channel`
    };
    fs.writeFileSync(storePath(), JSON.stringify({ legacykey: legacyEntry }, null, 2), {
      encoding: "utf-8",
    });

    const db = openSessionDb(dir());
    if (!db) {
      return;
    }
    migrateJsonToSqliteIfNeeded({ db, storePath: storePath() });

    const retrieved = getSessionEntry(db, "legacykey") as Record<string, unknown> | undefined;
    // After migration, `channel` should be set; `provider` should be gone
    expect(retrieved?.["channel"]).toBe("telegram");
    expect(retrieved?.["provider"]).toBeUndefined();
  });

  it("handles empty sessions.json gracefully", () => {
    fs.writeFileSync(storePath(), "{}", { encoding: "utf-8" });

    const db = openSessionDb(dir());
    if (!db) {
      return;
    }
    const result = migrateJsonToSqliteIfNeeded({ db, storePath: storePath() });
    // Empty store: 0 entries imported; migration recorded
    expect(result.migrated).toBe(0);
    expect(result.skipped).toBe(false);

    // Subsequent call should skip
    const result2 = migrateJsonToSqliteIfNeeded({ db, storePath: storePath() });
    expect(result2.skipped).toBe(true);
  });

  it("loads correct data after migration via loadAllSessionsFromDb", () => {
    const entries: Record<string, SessionEntry> = {};
    for (let i = 0; i < 5; i++) {
      entries[`key-${i}`] = makeEntry({ sessionId: `sid-${i}` });
    }
    writeSessionsJson(storePath(), entries);

    const db = openSessionDb(dir());
    if (!db) {
      return;
    }
    migrateJsonToSqliteIfNeeded({ db, storePath: storePath() });

    const all = loadAllSessionsFromDb(db);
    expect(Object.keys(all)).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(all[`key-${i}`]?.sessionId).toBe(`sid-${i}`);
    }
  });
});
