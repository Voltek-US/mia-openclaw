import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addShoppingItem,
  clearMiaDbCacheForTest,
  completeHouseholdTask,
  failStaleTasks,
  getDueTasks,
  getHeartbeatState,
  getIdeasWithEmbeddings,
  getShoppingList,
  getUnnotifiedErrors,
  insertContentIdea,
  insertHouseholdTask,
  logError,
  markErrorsNotified,
  markShoppingBought,
  markTaskDone,
  markTaskFailed,
  markTaskRunning,
  openMiaDb,
  queueTask,
  queryErrors,
  queryHouseholdTasks,
  querySocialMetrics,
  queryTaskQueue,
  queryTasks,
  rescheduleTaskRetry,
  resolveError,
  seedDefaultTasks,
  setHeartbeatState,
  upsertSocialMetric,
} from "./mia-store.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = path.join(
    os.tmpdir(),
    `mia-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
});

afterEach(() => {
  clearMiaDbCacheForTest();
});

// ============================================================================
// openMiaDb
// ============================================================================

describe("openMiaDb", () => {
  it("opens a database and returns a handle", () => {
    const db = openMiaDb(tmpDir);
    expect(db).not.toBeNull();
  });

  it("returns the same handle on repeated calls (cache)", () => {
    const db1 = openMiaDb(tmpDir);
    const db2 = openMiaDb(tmpDir);
    expect(db1).toBe(db2);
  });
});

// ============================================================================
// seedDefaultTasks / queryTasks
// ============================================================================

describe("seedDefaultTasks", () => {
  it("inserts the default task definitions", () => {
    const db = openMiaDb(tmpDir)!;
    const count = seedDefaultTasks(db);
    expect(count).toBeGreaterThan(0);
    const tasks = queryTasks(db);
    expect(tasks.length).toBeGreaterThanOrEqual(12);
  });

  it("is idempotent — re-seeding inserts 0 rows", () => {
    const db = openMiaDb(tmpDir)!;
    seedDefaultTasks(db);
    const second = seedDefaultTasks(db);
    expect(second).toBe(0);
  });

  it("seeds the morning-briefing task with type=scheduled", () => {
    const db = openMiaDb(tmpDir)!;
    seedDefaultTasks(db);
    const [task] = queryTasks(db, { type: "scheduled" }).filter((t) => t.id === "morning-briefing");
    expect(task).toBeDefined();
    expect(task.schedule).toBe("0 8 * * *");
    expect(task.priority).toBe(1);
  });

  it("seeds adhoc tasks with null schedule", () => {
    const db = openMiaDb(tmpDir)!;
    seedDefaultTasks(db);
    const adhoc = queryTasks(db, { type: "adhoc" });
    expect(adhoc.length).toBeGreaterThan(0);
    for (const t of adhoc) {
      expect(t.schedule).toBeNull();
    }
  });
});

// ============================================================================
// task_queue
// ============================================================================

describe("task_queue", () => {
  it("queues a task and retrieves it as pending", () => {
    const db = openMiaDb(tmpDir)!;
    seedDefaultTasks(db);
    const id = queueTask(db, { taskId: "morning-briefing", scheduledFor: Date.now() });
    expect(id).toBeGreaterThan(0);
    const rows = queryTaskQueue(db, { taskId: "morning-briefing", status: "pending" });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(id);
  });

  it("getDueTasks returns pending tasks with scheduled_for <= now", () => {
    const db = openMiaDb(tmpDir)!;
    seedDefaultTasks(db);
    const past = Date.now() - 5000;
    const future = Date.now() + 60_000;
    queueTask(db, { taskId: "morning-briefing", scheduledFor: past });
    queueTask(db, { taskId: "error-report", scheduledFor: future });
    const due = getDueTasks(db);
    expect(due).toHaveLength(1);
    expect(due[0].task_id).toBe("morning-briefing");
  });

  it("markTaskRunning → markTaskDone transitions status correctly", () => {
    const db = openMiaDb(tmpDir)!;
    seedDefaultTasks(db);
    const qId = queueTask(db, { taskId: "morning-briefing", scheduledFor: Date.now() - 1 });
    markTaskRunning(db, qId);
    const running = queryTaskQueue(db, { status: "running" });
    expect(running).toHaveLength(1);
    markTaskDone(db, qId, "Briefing sent.");
    const done = queryTaskQueue(db, { status: "done" });
    expect(done).toHaveLength(1);
    expect(done[0].output).toBe("Briefing sent.");
  });

  it("markTaskFailed sets status=failed with error text", () => {
    const db = openMiaDb(tmpDir)!;
    seedDefaultTasks(db);
    const qId = queueTask(db, { taskId: "social-sync", scheduledFor: Date.now() - 1 });
    markTaskRunning(db, qId);
    markTaskFailed(db, qId, "Rate limit exceeded");
    const failed = queryTaskQueue(db, { status: "failed" });
    expect(failed).toHaveLength(1);
    expect(failed[0].error).toBe("Rate limit exceeded");
  });

  it("rescheduleTaskRetry increments retry_count and resets to pending", () => {
    const db = openMiaDb(tmpDir)!;
    seedDefaultTasks(db);
    const qId = queueTask(db, { taskId: "social-sync", scheduledFor: Date.now() - 1 });
    markTaskRunning(db, qId);
    rescheduleTaskRetry(db, qId, Date.now() + 300_000);
    const rows = queryTaskQueue(db, { status: "pending" });
    expect(rows).toHaveLength(1);
    expect(rows[0].retry_count).toBe(1);
  });

  it("failStaleTasks auto-fails running tasks older than threshold", () => {
    const db = openMiaDb(tmpDir)!;
    seedDefaultTasks(db);
    const qId = queueTask(db, { taskId: "morning-briefing", scheduledFor: Date.now() - 1 });
    // Manually set started_at to 40 minutes ago to simulate a stale task
    db.prepare(`UPDATE task_queue SET status='running', started_at=? WHERE id=?`).run(
      Date.now() - 40 * 60 * 1000,
      qId,
    );
    const count = failStaleTasks(db, 30 * 60 * 1000);
    expect(count).toBe(1);
    const rows = queryTaskQueue(db, { status: "failed" });
    expect(rows).toHaveLength(1);
  });
});

// ============================================================================
// errors
// ============================================================================

describe("errors", () => {
  it("logs an error and retrieves it", () => {
    const db = openMiaDb(tmpDir)!;
    const id = logError(db, {
      errorType: "network",
      message: "Connection timeout",
      taskId: "social-sync",
    });
    expect(id).toBeGreaterThan(0);
    const rows = queryErrors(db, { resolved: false });
    expect(rows).toHaveLength(1);
    expect(rows[0].error_type).toBe("network");
    expect(rows[0].task_id).toBe("social-sync");
  });

  it("resolveError marks resolved=1 and stores resolution", () => {
    const db = openMiaDb(tmpDir)!;
    const id = logError(db, { errorType: "auth", message: "Token expired", taskId: "social-sync" });
    resolveError(db, id, "Re-authenticated via Telegram prompt");
    const rows = queryErrors(db, { resolved: true });
    expect(rows).toHaveLength(1);
    expect(rows[0].resolution).toBe("Re-authenticated via Telegram prompt");
    expect(rows[0].resolved_at).not.toBeNull();
  });

  it("getUnnotifiedErrors returns errors older than the threshold that need notification", () => {
    const db = openMiaDb(tmpDir)!;
    const id = logError(db, { errorType: "unknown", message: "Crash", taskId: "morning-briefing" });
    // Backdate occurred_at to 10 minutes ago so it passes the 5-min threshold
    db.prepare(`UPDATE errors SET occurred_at=? WHERE id=?`).run(Date.now() - 10 * 60 * 1000, id);
    const unnotified = getUnnotifiedErrors(db);
    expect(unnotified).toHaveLength(1);
    markErrorsNotified(db, [id]);
    expect(getUnnotifiedErrors(db)).toHaveLength(0);
  });
});

// ============================================================================
// social_metrics
// ============================================================================

describe("social_metrics", () => {
  it("upserts a metric snapshot", () => {
    const db = openMiaDb(tmpDir)!;
    upsertSocialMetric(db, {
      platform: "twitter",
      metricType: "post",
      sourceId: "tweet-123",
      metricsJson: JSON.stringify({ impressions: 500, likes: 20 }),
    });
    const rows = querySocialMetrics(db, { platform: "twitter" });
    expect(rows).toHaveLength(1);
    expect(rows[0].platform).toBe("twitter");
  });

  it("deduplicates metrics per platform+source per day", () => {
    const db = openMiaDb(tmpDir)!;
    const dayMs = Math.floor(Date.now() / 86400000) * 86400000;
    upsertSocialMetric(db, {
      platform: "instagram",
      metricType: "post",
      sourceId: "ig-post-1",
      metricsJson: '{"likes":10}',
      collectedAt: dayMs,
    });
    upsertSocialMetric(db, {
      platform: "instagram",
      metricType: "post",
      sourceId: "ig-post-1",
      metricsJson: '{"likes":15}',
      collectedAt: dayMs + 3600_000, // same day, different hour
    });
    const rows = querySocialMetrics(db, { platform: "instagram" });
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].metrics_json).likes).toBe(15);
  });
});

// ============================================================================
// household_tasks
// ============================================================================

describe("household_tasks", () => {
  it("inserts and queries a household task", () => {
    const db = openMiaDb(tmpDir)!;
    const id = insertHouseholdTask(db, {
      title: "Take out bins",
      category: "home",
      autoResolve: true,
    });
    expect(id).toBeGreaterThan(0);
    const rows = queryHouseholdTasks(db, { status: "open" });
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Take out bins");
    expect(rows[0].auto_resolve).toBe(1);
  });

  it("completeHouseholdTask marks the task done", () => {
    const db = openMiaDb(tmpDir)!;
    const id = insertHouseholdTask(db, { title: "Clean kitchen", category: "home" });
    completeHouseholdTask(db, id);
    const done = queryHouseholdTasks(db, { status: "done" });
    expect(done).toHaveLength(1);
    expect(done[0].completed_at).not.toBeNull();
  });
});

// ============================================================================
// shopping
// ============================================================================

describe("shopping", () => {
  it("adds and retrieves an unbought item", () => {
    const db = openMiaDb(tmpDir)!;
    addShoppingItem(db, { item: "Milk", quantity: "2L", category: "grocery" });
    const list = getShoppingList(db);
    expect(list).toHaveLength(1);
    expect(list[0].item).toBe("Milk");
  });

  it("markShoppingBought removes item from active list", () => {
    const db = openMiaDb(tmpDir)!;
    const id = addShoppingItem(db, { item: "Eggs" });
    markShoppingBought(db, id);
    expect(getShoppingList(db)).toHaveLength(0);
  });
});

// ============================================================================
// content_ideas
// ============================================================================

describe("content_ideas", () => {
  it("inserts a content idea and retrieves it", () => {
    const db = openMiaDb(tmpDir)!;
    const id = insertContentIdea(db, {
      title: "How AI helps with household management",
      platform: "linkedin",
      embeddingJson: JSON.stringify([0.1, 0.2, 0.3]),
    });
    expect(id).toBeGreaterThan(0);
    const ideas = getIdeasWithEmbeddings(db);
    expect(ideas).toHaveLength(1);
    expect(ideas[0].platform).toBe("linkedin");
  });
});

// ============================================================================
// heartbeat_state
// ============================================================================

describe("heartbeat_state", () => {
  it("returns null for an unset key", () => {
    const db = openMiaDb(tmpDir)!;
    expect(getHeartbeatState(db, "nonexistent")).toBeNull();
  });

  it("sets and gets a heartbeat state value", () => {
    const db = openMiaDb(tmpDir)!;
    setHeartbeatState(db, "social-monitor-last-run", "1700000000000");
    expect(getHeartbeatState(db, "social-monitor-last-run")).toBe("1700000000000");
  });

  it("overwrites on repeated set", () => {
    const db = openMiaDb(tmpDir)!;
    setHeartbeatState(db, "k", "first");
    setHeartbeatState(db, "k", "second");
    expect(getHeartbeatState(db, "k")).toBe("second");
  });
});
