import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearNotifyQueueDbCacheForTest,
  countPendingByTier,
  enqueueNotification,
  ensureNotifyQueueSchema,
  fetchPendingByTier,
  listPending,
  markDelivered,
  openNotifyQueueDb,
  pruneDelivered,
} from "./store.js";

function tempDbPath(): string {
  return path.join(os.tmpdir(), `notify-queue-test-${randomUUID()}.sqlite`);
}

describe("notify-queue/store", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = tempDbPath();
  });

  afterEach(() => {
    clearNotifyQueueDbCacheForTest();
  });

  it("opens and initializes schema without error", () => {
    const db = openNotifyQueueDb(dbPath);
    expect(db).toBeDefined();
    // Schema idempotent — calling again should not throw.
    ensureNotifyQueueSchema(db);
  });

  it("enqueues and fetches a notification by tier", () => {
    const db = openNotifyQueueDb(dbPath);
    const id = enqueueNotification(db, {
      tier: "high",
      channel: "telegram",
      message: "Job failed",
      messageType: "job-failure",
      topic: "ci",
    });

    expect(typeof id).toBe("string");

    const pending = fetchPendingByTier(db, "high");
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(id);
    expect(pending[0].tier).toBe("high");
    expect(pending[0].channel).toBe("telegram");
    expect(pending[0].message).toBe("Job failed");
    expect(pending[0].messageType).toBe("job-failure");
    expect(pending[0].topic).toBe("ci");
    expect(pending[0].deliveredAt).toBeUndefined();
  });

  it("does not return entries for a different tier", () => {
    const db = openNotifyQueueDb(dbPath);
    enqueueNotification(db, { tier: "medium", channel: "slack", message: "Info" });
    const high = fetchPendingByTier(db, "high");
    expect(high).toHaveLength(0);
  });

  it("marks entries as delivered", () => {
    const db = openNotifyQueueDb(dbPath);
    const id1 = enqueueNotification(db, { tier: "high", channel: "telegram", message: "A" });
    const id2 = enqueueNotification(db, { tier: "high", channel: "telegram", message: "B" });

    markDelivered(db, [id1]);

    const pending = fetchPendingByTier(db, "high");
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(id2);
  });

  it("markDelivered with empty array is a no-op", () => {
    const db = openNotifyQueueDb(dbPath);
    enqueueNotification(db, { tier: "medium", channel: "slack", message: "X" });
    expect(() => markDelivered(db, [])).not.toThrow();
    expect(fetchPendingByTier(db, "medium")).toHaveLength(1);
  });

  it("countPendingByTier returns correct counts", () => {
    const db = openNotifyQueueDb(dbPath);
    enqueueNotification(db, { tier: "critical", channel: "telegram", message: "Err" });
    enqueueNotification(db, { tier: "high", channel: "telegram", message: "Warn1" });
    enqueueNotification(db, { tier: "high", channel: "telegram", message: "Warn2" });

    const counts = countPendingByTier(db);
    expect(counts.critical).toBe(1);
    expect(counts.high).toBe(2);
    expect(counts.medium).toBe(0);
  });

  it("listPending returns all pending entries across tiers", () => {
    const db = openNotifyQueueDb(dbPath);
    enqueueNotification(db, { tier: "critical", channel: "telegram", message: "C" });
    enqueueNotification(db, { tier: "medium", channel: "slack", message: "M" });

    const all = listPending(db);
    expect(all).toHaveLength(2);

    const byTier = listPending(db, "medium");
    expect(byTier).toHaveLength(1);
    expect(byTier[0].tier).toBe("medium");
  });

  it("pruneDelivered removes old delivered entries", () => {
    const db = openNotifyQueueDb(dbPath);
    const id = enqueueNotification(db, { tier: "medium", channel: "slack", message: "Old" });
    markDelivered(db, [id]);

    // Prune with maxAge = -1 sets cutoff = Date.now() + 1 ms, guaranteeing all delivered rows are pruned.
    const removed = pruneDelivered(db, -1);
    expect(removed).toBe(1);

    const pending = listPending(db);
    expect(pending).toHaveLength(0);
  });

  it("pruneDelivered does not remove recent delivered entries", () => {
    const db = openNotifyQueueDb(dbPath);
    const id = enqueueNotification(db, { tier: "medium", channel: "slack", message: "New" });
    markDelivered(db, [id]);

    // Large maxAge — should not prune.
    const removed = pruneDelivered(db, 30 * 24 * 60 * 60 * 1000);
    expect(removed).toBe(0);
  });

  it("serializes and deserializes metadata", () => {
    const db = openNotifyQueueDb(dbPath);
    const meta = { jobId: "abc-123", attempt: 2 };
    const id = enqueueNotification(db, {
      tier: "high",
      channel: "discord",
      message: "Job done",
      metadata: meta,
    });

    const entries = fetchPendingByTier(db, "high");
    const entry = entries.find((e) => e.id === id);
    expect(entry?.metadata).toEqual(meta);
  });

  it("reuses the cached DB handle for the same path", () => {
    const db1 = openNotifyQueueDb(dbPath);
    const db2 = openNotifyQueueDb(dbPath);
    expect(db1).toBe(db2);
  });

  it("orders pending entries by enqueued_at ascending", () => {
    const db = openNotifyQueueDb(dbPath);
    // Insert in order; IDs are random UUIDs, so only time ordering matters.
    enqueueNotification(db, { tier: "high", channel: "telegram", message: "First" });
    enqueueNotification(db, { tier: "high", channel: "telegram", message: "Second" });
    enqueueNotification(db, { tier: "high", channel: "telegram", message: "Third" });

    const pending = fetchPendingByTier(db, "high");
    expect(pending.map((e) => e.message)).toEqual(["First", "Second", "Third"]);
  });
});
