import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearKbDbCacheForTest, openKbDb, runPreflightChecks } from "./db.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kb-test-"));
  clearKbDbCacheForTest();
});

afterEach(async () => {
  clearKbDbCacheForTest();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("openKbDb", () => {
  it("creates all expected tables on a fresh DB", async () => {
    const dbPath = path.join(tmpDir, "kb.db");
    const { db } = await openKbDb(dbPath);

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type IN ('table','shadow','virtual') ORDER BY name",
      )
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);

    expect(names).toContain("kb_sources");
    expect(names).toContain("kb_chunks");
    expect(names).toContain("kb_meta");
    // FTS tables create shadow tables
    expect(names.some((n) => n.startsWith("kb_chunks_fts"))).toBe(true);
  });

  it("returns same cached instance on second call", async () => {
    const dbPath = path.join(tmpDir, "kb.db");
    const a = await openKbDb(dbPath);
    const b = await openKbDb(dbPath);
    expect(a.db).toBe(b.db);
  });

  it("schema is idempotent — second openKbDb does not throw", async () => {
    const dbPath = path.join(tmpDir, "kb.db");
    await openKbDb(dbPath);
    clearKbDbCacheForTest();
    await expect(openKbDb(dbPath)).resolves.toBeDefined();
  });

  it("gracefully returns vecAvailable=false when sqlite-vec fails", async () => {
    const dbPath = path.join(tmpDir, "kb.db");
    // Mock loadSqliteVecExtension to fail.
    const mod = await import("openclaw/plugin-sdk/knowledge-base");
    vi.spyOn(mod, "loadSqliteVecExtension").mockResolvedValue({
      ok: false,
      error: "not available",
    });

    const { vecAvailable } = await openKbDb(dbPath);
    expect(vecAvailable).toBe(false);

    vi.restoreAllMocks();
  });
});

describe("runPreflightChecks", () => {
  it("returns ok=true when directory exists and DB is valid", async () => {
    const dbPath = path.join(tmpDir, "kb.db");
    await openKbDb(dbPath); // creates the DB
    clearKbDbCacheForTest();

    const result = await runPreflightChecks(dbPath);
    expect(result.ok).toBe(true);
    expect(result.issues.filter((i) => !i.startsWith("Removed"))).toHaveLength(0);
  });

  it("returns ok=false when parent directory does not exist", async () => {
    const dbPath = path.join(tmpDir, "nonexistent-dir", "kb.db");
    const result = await runPreflightChecks(dbPath);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.includes("does not exist"))).toBe(true);
  });

  it("removes stale lock file when owning PID is dead", async () => {
    const dbPath = path.join(tmpDir, "kb.db");
    const lockPath = path.join(tmpDir, ".kb.lock");
    // Write a lock file with a non-existent PID.
    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: 999999999, createdAt: new Date().toISOString() }),
    );

    const result = await runPreflightChecks(dbPath);
    expect(result.issues.some((i) => i.includes("Removed stale lock"))).toBe(true);
    // Lock file should be gone.
    await expect(fs.access(lockPath)).rejects.toThrow();
  });

  it("returns ok=true for non-existent DB (fresh install)", async () => {
    const dbPath = path.join(tmpDir, "kb.db");
    const result = await runPreflightChecks(dbPath);
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });
});
