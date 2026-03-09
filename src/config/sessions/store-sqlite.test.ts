import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  batchUpsertSessions,
  capSessionCount,
  clearSessionDbCacheForTest,
  deleteSessionEntries,
  ensureSessionDbSchema,
  getSessionCount,
  getSessionEntriesByKeyPrefix,
  getSessionEntry,
  loadAllSessionsFromDb,
  openSessionDb,
  pruneSessionsOlderThan,
  pruneSessionsOlderThanWithKeys,
  upsertSessionEntry,
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
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-sqlite-test-"));
  });
  afterEach(() => {
    clearSessionDbCacheForTest();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir: () => dir };
}

describe("openSessionDb + ensureSessionDbSchema", () => {
  const { dir } = useTempDir();

  it("opens a DB and returns a DatabaseSync handle", () => {
    const db = openSessionDb(dir());
    expect(db).not.toBeNull();
  });

  it("returns the same cached handle on repeated calls", () => {
    const db1 = openSessionDb(dir());
    const db2 = openSessionDb(dir());
    expect(db1).toBe(db2);
  });

  it("ensureSessionDbSchema is idempotent", () => {
    const db = openSessionDb(dir());
    if (!db) {
      return;
    }
    // Calling again should not throw
    expect(() => ensureSessionDbSchema(db)).not.toThrow();
  });

  it("creates sessions and schema_meta tables", () => {
    const db = openSessionDb(dir());
    if (!db) {
      return;
    }
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
      name: string;
    }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain("sessions");
    expect(names).toContain("schema_meta");
  });
});

describe("upsertSessionEntry + getSessionEntry", () => {
  const { dir } = useTempDir();

  it("inserts a new entry", () => {
    const db = openSessionDb(dir());
    if (!db) {
      return;
    }
    const entry = makeEntry({ sessionId: "sid-1" });
    upsertSessionEntry(db, "key-1", entry);
    const retrieved = getSessionEntry(db, "key-1");
    expect(retrieved?.sessionId).toBe("sid-1");
  });

  it("updates an existing entry on duplicate key", () => {
    const db = openSessionDb(dir());
    if (!db) {
      return;
    }
    const entry = makeEntry({ sessionId: "sid-1", updatedAt: 1000 });
    upsertSessionEntry(db, "key-1", entry);
    const updated = { ...entry, updatedAt: 2000 };
    upsertSessionEntry(db, "key-1", updated);
    const retrieved = getSessionEntry(db, "key-1");
    expect(retrieved?.updatedAt).toBe(2000);
  });

  it("preserves created_at on upsert", () => {
    const db = openSessionDb(dir());
    if (!db) {
      return;
    }
    const entry = makeEntry({ sessionId: "sid-1", updatedAt: 1000 });
    upsertSessionEntry(db, "key-1", entry);
    const row1 = db
      .prepare("SELECT created_at FROM sessions WHERE session_key = ?")
      .get("key-1") as { created_at: number };
    const createdAt = row1.created_at;

    upsertSessionEntry(db, "key-1", { ...entry, updatedAt: 2000 });
    const row2 = db
      .prepare("SELECT created_at FROM sessions WHERE session_key = ?")
      .get("key-1") as { created_at: number };
    expect(row2.created_at).toBe(createdAt);
  });

  it("returns undefined for missing key", () => {
    const db = openSessionDb(dir());
    if (!db) {
      return;
    }
    expect(getSessionEntry(db, "nonexistent")).toBeUndefined();
  });
});

describe("loadAllSessionsFromDb", () => {
  const { dir } = useTempDir();

  it("returns empty object when no sessions", () => {
    const db = openSessionDb(dir());
    if (!db) {
      return;
    }
    expect(loadAllSessionsFromDb(db)).toEqual({});
  });

  it("returns all inserted sessions keyed by session_key", () => {
    const db = openSessionDb(dir());
    if (!db) {
      return;
    }
    const e1 = makeEntry({ sessionId: "s1" });
    const e2 = makeEntry({ sessionId: "s2" });
    upsertSessionEntry(db, "k1", e1);
    upsertSessionEntry(db, "k2", e2);
    const all = loadAllSessionsFromDb(db);
    expect(Object.keys(all)).toHaveLength(2);
    expect(all["k1"]?.sessionId).toBe("s1");
    expect(all["k2"]?.sessionId).toBe("s2");
  });
});

describe("getSessionEntriesByKeyPrefix", () => {
  const { dir } = useTempDir();

  it("finds entry with exact normalized key", () => {
    const db = openSessionDb(dir());
    if (!db) {
      return;
    }
    upsertSessionEntry(db, "mykey", makeEntry({ sessionId: "sid" }));
    const results = getSessionEntriesByKeyPrefix(db, "mykey");
    expect(results).toHaveLength(1);
    expect(results[0].key).toBe("mykey");
  });

  it("finds no results for missing key", () => {
    const db = openSessionDb(dir());
    if (!db) {
      return;
    }
    const results = getSessionEntriesByKeyPrefix(db, "nope");
    expect(results).toHaveLength(0);
  });
});

describe("deleteSessionEntries", () => {
  const { dir } = useTempDir();

  it("deletes specified keys", () => {
    const db = openSessionDb(dir());
    if (!db) {
      return;
    }
    upsertSessionEntry(db, "k1", makeEntry());
    upsertSessionEntry(db, "k2", makeEntry());
    upsertSessionEntry(db, "k3", makeEntry());
    deleteSessionEntries(db, ["k1", "k3"]);
    expect(getSessionEntry(db, "k1")).toBeUndefined();
    expect(getSessionEntry(db, "k2")).toBeDefined();
    expect(getSessionEntry(db, "k3")).toBeUndefined();
  });

  it("is a no-op for empty array", () => {
    const db = openSessionDb(dir());
    if (!db) {
      return;
    }
    upsertSessionEntry(db, "k1", makeEntry());
    deleteSessionEntries(db, []);
    expect(getSessionEntry(db, "k1")).toBeDefined();
  });
});

describe("pruneSessionsOlderThan", () => {
  const { dir } = useTempDir();

  it("deletes entries older than cutoff", () => {
    const db = openSessionDb(dir());
    if (!db) {
      return;
    }
    const now = Date.now();
    upsertSessionEntry(db, "old", makeEntry({ updatedAt: now - 100_000 }));
    upsertSessionEntry(db, "new", makeEntry({ updatedAt: now }));
    const count = pruneSessionsOlderThan(db, now - 50_000);
    expect(count).toBe(1);
    expect(getSessionEntry(db, "old")).toBeUndefined();
    expect(getSessionEntry(db, "new")).toBeDefined();
  });

  it("returns 0 when nothing to prune", () => {
    const db = openSessionDb(dir());
    if (!db) {
      return;
    }
    upsertSessionEntry(db, "k1", makeEntry({ updatedAt: Date.now() }));
    const count = pruneSessionsOlderThan(db, 0);
    expect(count).toBe(0);
  });
});

describe("pruneSessionsOlderThanWithKeys", () => {
  const { dir } = useTempDir();

  it("returns deleted keys", () => {
    const db = openSessionDb(dir());
    if (!db) {
      return;
    }
    const now = Date.now();
    upsertSessionEntry(db, "old", makeEntry({ updatedAt: now - 100_000 }));
    upsertSessionEntry(db, "new", makeEntry({ updatedAt: now }));
    const keys = pruneSessionsOlderThanWithKeys(db, now - 50_000);
    expect(keys).toEqual(["old"]);
  });
});

describe("capSessionCount", () => {
  const { dir } = useTempDir();

  it("removes oldest entries beyond cap", () => {
    const db = openSessionDb(dir());
    if (!db) {
      return;
    }
    const now = Date.now();
    upsertSessionEntry(db, "k1", makeEntry({ updatedAt: now - 3000 }));
    upsertSessionEntry(db, "k2", makeEntry({ updatedAt: now - 2000 }));
    upsertSessionEntry(db, "k3", makeEntry({ updatedAt: now - 1000 }));
    const removed = capSessionCount(db, 2);
    expect(removed).toHaveLength(1);
    // k1 is oldest and should be removed
    expect(getSessionEntry(db, "k1")).toBeUndefined();
    expect(getSessionEntry(db, "k2")).toBeDefined();
    expect(getSessionEntry(db, "k3")).toBeDefined();
  });

  it("is a no-op when under cap", () => {
    const db = openSessionDb(dir());
    if (!db) {
      return;
    }
    upsertSessionEntry(db, "k1", makeEntry());
    const removed = capSessionCount(db, 10);
    expect(removed).toHaveLength(0);
    expect(getSessionEntry(db, "k1")).toBeDefined();
  });
});

describe("getSessionCount", () => {
  const { dir } = useTempDir();

  it("returns 0 for empty DB", () => {
    const db = openSessionDb(dir());
    if (!db) {
      return;
    }
    expect(getSessionCount(db)).toBe(0);
  });

  it("returns correct count after inserts and deletes", () => {
    const db = openSessionDb(dir());
    if (!db) {
      return;
    }
    upsertSessionEntry(db, "k1", makeEntry());
    upsertSessionEntry(db, "k2", makeEntry());
    expect(getSessionCount(db)).toBe(2);
    deleteSessionEntries(db, ["k1"]);
    expect(getSessionCount(db)).toBe(1);
  });
});

describe("batchUpsertSessions", () => {
  const { dir } = useTempDir();

  it("upserts all entries in a transaction", () => {
    const db = openSessionDb(dir());
    if (!db) {
      return;
    }
    const store = {
      k1: makeEntry({ sessionId: "s1" }),
      k2: makeEntry({ sessionId: "s2" }),
      k3: makeEntry({ sessionId: "s3" }),
    };
    batchUpsertSessions(db, store);
    expect(getSessionCount(db)).toBe(3);
    expect(getSessionEntry(db, "k1")?.sessionId).toBe("s1");
  });

  it("handles empty store without error", () => {
    const db = openSessionDb(dir());
    if (!db) {
      return;
    }
    expect(() => batchUpsertSessions(db, {})).not.toThrow();
  });
});

describe("clearSessionDbCacheForTest", () => {
  it("allows re-opening a fresh DB in the same test process", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-sqlite-clear-"));
    try {
      openSessionDb(tempDir);
      clearSessionDbCacheForTest();
      // After clearing, opening again should succeed with a fresh handle
      const db2 = openSessionDb(tempDir);
      expect(db2).not.toBeNull();
      // Verify the new handle is functional
      if (db2) {
        const entry = makeEntry({ sessionId: "s-after-clear" });
        upsertSessionEntry(db2, "k-after-clear", entry);
        expect(getSessionEntry(db2, "k-after-clear")?.sessionId).toBe("s-after-clear");
      }
    } finally {
      clearSessionDbCacheForTest();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
