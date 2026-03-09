import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildDigest, flushTier, formatDigestGroup } from "./flush.js";
import {
  clearNotifyQueueDbCacheForTest,
  enqueueNotification,
  fetchPendingByTier,
  openNotifyQueueDb,
} from "./store.js";
import type { DigestGroup } from "./store.js";

function tempDbPath(): string {
  return path.join(os.tmpdir(), `flush-test-${randomUUID()}.sqlite`);
}

describe("buildDigest", () => {
  it("returns plain message for single group with one message", () => {
    const groups: DigestGroup[] = [{ channel: "telegram", messages: ["Build complete"] }];
    expect(buildDigest(groups)).toBe("Build complete");
  });

  it("builds multi-message digest with header and footer", () => {
    const groups: DigestGroup[] = [
      { channel: "telegram", topic: "ci", messages: ["Job A failed", "Job B failed"] },
    ];
    const digest = buildDigest(groups);
    expect(digest).toContain("[OpenClaw Digest");
    expect(digest).toContain("2 updates");
    expect(digest).toContain("--- ci (2) ---");
    expect(digest).toContain("\u2022 Job A failed");
    expect(digest).toContain("Delivered by OpenClaw notify-queue");
  });

  it("groups multiple topics in one digest", () => {
    const groups: DigestGroup[] = [
      { channel: "telegram", topic: "ci", messages: ["CI failed"] },
      { channel: "telegram", topic: "deploy", messages: ["Deploy done"] },
    ];
    const digest = buildDigest(groups);
    expect(digest).toContain("2 updates");
    expect(digest).toContain("--- ci (1) ---");
    expect(digest).toContain("--- deploy (1) ---");
  });

  it("uses 'general' label for entries without topic", () => {
    const groups: DigestGroup[] = [{ channel: "telegram", messages: ["A", "B"] }];
    const digest = buildDigest(groups);
    expect(digest).toContain("--- general (2) ---");
  });

  it("uses singular 'update' for one message multi-group edge case", () => {
    // One group, multiple messages means plural.
    const groups: DigestGroup[] = [{ channel: "telegram", messages: ["A", "B", "C"] }];
    const digest = buildDigest(groups);
    expect(digest).toContain("3 updates");
  });
});

describe("formatDigestGroup", () => {
  it("formats group with topic", () => {
    const group: DigestGroup = { channel: "telegram", topic: "alerts", messages: ["Msg1"] };
    const text = formatDigestGroup(group);
    expect(text).toContain("--- alerts (1) ---");
    expect(text).toContain("\u2022 Msg1");
  });

  it("uses 'general' when no topic", () => {
    const group: DigestGroup = { channel: "telegram", messages: ["Msg"] };
    const text = formatDigestGroup(group);
    expect(text).toContain("--- general (1) ---");
  });
});

describe("flushTier", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = tempDbPath();
  });

  afterEach(() => {
    clearNotifyQueueDbCacheForTest();
  });

  it("returns zero flushed when queue is empty", async () => {
    const db = openNotifyQueueDb(dbPath);
    const deliverFn = vi.fn().mockResolvedValue(undefined);
    const result = await flushTier(db, "high", deliverFn);
    expect(result.flushed).toBe(0);
    expect(deliverFn).not.toHaveBeenCalled();
  });

  it("delivers and marks entries as delivered", async () => {
    const db = openNotifyQueueDb(dbPath);
    enqueueNotification(db, { tier: "high", channel: "telegram", message: "Warn A", topic: "ci" });
    enqueueNotification(db, { tier: "high", channel: "telegram", message: "Warn B", topic: "ci" });

    const deliverFn = vi.fn().mockResolvedValue(undefined);
    const result = await flushTier(db, "high", deliverFn);

    expect(result.flushed).toBe(2);
    expect(deliverFn).toHaveBeenCalledOnce();
    expect(deliverFn).toHaveBeenCalledWith("telegram", expect.stringContaining("Warn A"));

    // Entries should now be marked delivered.
    const remaining = fetchPendingByTier(db, "high");
    expect(remaining).toHaveLength(0);
  });

  it("sends one digest per channel", async () => {
    const db = openNotifyQueueDb(dbPath);
    enqueueNotification(db, { tier: "medium", channel: "telegram", message: "T1" });
    enqueueNotification(db, { tier: "medium", channel: "slack", message: "S1" });

    const deliverFn = vi.fn().mockResolvedValue(undefined);
    const result = await flushTier(db, "medium", deliverFn);

    expect(result.flushed).toBe(2);
    expect(deliverFn).toHaveBeenCalledTimes(2);
    const channels = deliverFn.mock.calls.map((c) => c[0] as string).toSorted();
    expect(channels).toEqual(["slack", "telegram"]);
  });

  it("leaves entries pending when delivery throws", async () => {
    const db = openNotifyQueueDb(dbPath);
    enqueueNotification(db, { tier: "high", channel: "telegram", message: "Fail me" });

    const deliverFn = vi.fn().mockRejectedValue(new Error("network error"));
    const result = await flushTier(db, "high", deliverFn);

    expect(result.flushed).toBe(0);
    // Entry should still be pending.
    expect(fetchPendingByTier(db, "high")).toHaveLength(1);
  });

  it("does not flush entries for other tiers", async () => {
    const db = openNotifyQueueDb(dbPath);
    enqueueNotification(db, { tier: "medium", channel: "telegram", message: "Medium msg" });

    const deliverFn = vi.fn().mockResolvedValue(undefined);
    await flushTier(db, "high", deliverFn);

    expect(deliverFn).not.toHaveBeenCalled();
    expect(fetchPendingByTier(db, "medium")).toHaveLength(1);
  });
});
