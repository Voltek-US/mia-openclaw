#!/usr/bin/env bun
/**
 * cron-log-db.ts — Central SQLite cron run log
 *
 * Tracks cron job executions with start/end records, PID-based stale detection,
 * idempotency checks, and cross-job failure analysis.
 *
 * Usage:
 *   bun scripts/cron-log-db.ts <action> [args]
 *
 * Actions:
 *   log-start  <job-name> [--pid <n>]                        Record job start; prints {"runId":"..."}
 *   log-end    <run-id> <status> [--summary <s>] [--error <e>]  Record completion; prints {"ok":true}
 *   query      [--job <name>] [--status ok|error|running|...]    Query run history; prints JSON array
 *              [--from <iso>] [--to <iso>] [--limit <n>]
 *   should-run <job-name> --window today|this-hour            Idempotency check; exit 0=run, 1=skip
 *   cleanup-stale [--max-age-hours <n>]                       Mark stuck runs as failed; prints {"cleaned":N}
 *   check-failures [--window-hours <n>] [--threshold <n>]     Detect persistent failures; prints JSON
 *
 * DB location:
 *   Default: ~/.openclaw/cron-log.db
 *   Override: --db <path>  or  OPENCLAW_CRON_LOG_DB env var
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// SQLite shim (same pattern as scripts/log-ingest.ts)
// ---------------------------------------------------------------------------

type SqliteDB = {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
};

type SqliteStatement = {
  run(...args: unknown[]): { changes: number };
  all(...args: unknown[]): unknown[];
  get(...args: unknown[]): unknown;
};

function openSqlite(dbPath: string): SqliteDB {
  const require = createRequire(import.meta.url);

  if (typeof Bun !== "undefined") {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { Database } = require("bun:sqlite");
      return new Database(dbPath) as SqliteDB;
    } catch {
      // fall through to node:sqlite
    }
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { DatabaseSync } = require("node:sqlite");
    return new DatabaseSync(dbPath) as SqliteDB;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`SQLite unavailable (tried bun:sqlite and node:sqlite). ${msg}`, {
      cause: err,
    });
  }
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cron_runs (
  run_id      TEXT    PRIMARY KEY,
  job_name    TEXT    NOT NULL,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  status      TEXT    NOT NULL DEFAULT 'running',
  duration_ms INTEGER,
  summary     TEXT,
  error       TEXT,
  pid         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_cron_runs_job_name   ON cron_runs(job_name);
CREATE INDEX IF NOT EXISTS idx_cron_runs_started_at ON cron_runs(started_at);
CREATE INDEX IF NOT EXISTS idx_cron_runs_status     ON cron_runs(status);
`;

// ---------------------------------------------------------------------------
// DB open with WAL mode
// ---------------------------------------------------------------------------

function openDb(dbPath: string): SqliteDB {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openSqlite(dbPath);
  // WAL mode for concurrent read/write safety; same settings as store-sqlite.ts
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA);
  return db;
}

// ---------------------------------------------------------------------------
// UUID v4 (no external deps)
// ---------------------------------------------------------------------------

function randomUuid(): string {
  // Use crypto.randomUUID if available (Node 19+, Bun), else fallback
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const { randomBytes } = require("node:crypto") as typeof import("node:crypto");
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

type ParsedArgs = {
  action: string;
  positional: string[];
  flags: Record<string, string | true>;
};

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const action = args[0] ?? "";
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};

  for (let i = 1; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }

  return { action, positional, flags };
}

function flagStr(flags: Record<string, string | true>, key: string): string | undefined {
  const v = flags[key];
  return typeof v === "string" ? v : undefined;
}

function flagNum(flags: Record<string, string | true>, key: string, defaultVal: number): number {
  const v = flagStr(flags, key);
  if (!v) {
    return defaultVal;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : defaultVal;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** log-start <job-name> [--pid <n>] */
function actionLogStart(
  db: SqliteDB,
  positional: string[],
  flags: Record<string, string | true>,
): void {
  const jobName = positional[0]?.trim();
  if (!jobName) {
    process.stderr.write("log-start: job-name required\n");
    process.exit(1);
  }

  const pid = flagStr(flags, "pid") ? Number(flagStr(flags, "pid")) : undefined;
  const runId = randomUuid();
  const now = Date.now();

  // Auto cleanup stale runs before inserting new one
  const maxAgeMs = 2 * 60 * 60 * 1000; // 2 hours
  const staleThreshold = now - maxAgeMs;
  const cleanupResult = db
    .prepare(
      `UPDATE cron_runs
       SET status = 'error', finished_at = ?, error = 'stale: exceeded max age',
           duration_ms = ? - started_at
       WHERE status = 'running' AND started_at < ?`,
    )
    .run(now, now, staleThreshold);
  if ((cleanupResult.changes ?? 0) > 0) {
    process.stderr.write(
      `[cron-log-db] cleanup-stale: marked ${cleanupResult.changes} stale runs as failed\n`,
    );
  }

  db.prepare(
    `INSERT INTO cron_runs (run_id, job_name, started_at, status, pid)
     VALUES (?, ?, ?, 'running', ?)`,
  ).run(runId, jobName, now, pid ?? null);

  process.stdout.write(JSON.stringify({ runId }) + "\n");
}

/** log-end <run-id> <status> [--summary <s>] [--error <e>] */
function actionLogEnd(
  db: SqliteDB,
  positional: string[],
  flags: Record<string, string | true>,
): void {
  const runId = positional[0]?.trim();
  const status = positional[1]?.trim();

  if (!runId || !status) {
    process.stderr.write("log-end: run-id and status required\n");
    process.exit(1);
  }

  const validStatuses = ["ok", "error", "skipped", "interrupted", "timeout"];
  if (!validStatuses.includes(status)) {
    process.stderr.write(
      `log-end: invalid status '${status}' (expected: ${validStatuses.join("|")})\n`,
    );
    process.exit(1);
  }

  const summary = flagStr(flags, "summary") ?? null;
  const error = flagStr(flags, "error") ?? null;
  const now = Date.now();

  // Compute duration from started_at
  const row = db.prepare("SELECT started_at FROM cron_runs WHERE run_id = ?").get(runId) as
    | { started_at: number }
    | undefined
    | null;

  const startedAt = row?.started_at ?? now;
  const durationMs = now - startedAt;

  db.prepare(
    `UPDATE cron_runs
     SET status = ?, finished_at = ?, duration_ms = ?, summary = ?, error = ?
     WHERE run_id = ?`,
  ).run(status, now, durationMs, summary, error, runId);

  process.stdout.write(JSON.stringify({ ok: true }) + "\n");
}

type CronRunRow = {
  run_id: string;
  job_name: string;
  started_at: number;
  finished_at: number | null;
  status: string;
  duration_ms: number | null;
  summary: string | null;
  error: string | null;
  pid: number | null;
};

/** query [--job <name>] [--status <s>] [--from <iso>] [--to <iso>] [--limit <n>] */
function actionQuery(
  db: SqliteDB,
  _positional: string[],
  flags: Record<string, string | true>,
): void {
  const jobFilter = flagStr(flags, "job");
  const statusFilter = flagStr(flags, "status");
  const fromIso = flagStr(flags, "from");
  const toIso = flagStr(flags, "to");
  const limit = flagNum(flags, "limit", 50);

  const clauses: string[] = [];
  const params: unknown[] = [];

  if (jobFilter) {
    clauses.push("job_name = ?");
    params.push(jobFilter);
  }
  if (statusFilter) {
    clauses.push("status = ?");
    params.push(statusFilter);
  }
  if (fromIso) {
    const ms = Date.parse(fromIso);
    if (Number.isFinite(ms)) {
      clauses.push("started_at >= ?");
      params.push(ms);
    }
  }
  if (toIso) {
    const ms = Date.parse(toIso);
    if (Number.isFinite(ms)) {
      clauses.push("started_at <= ?");
      params.push(ms);
    }
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare(`SELECT * FROM cron_runs ${where} ORDER BY started_at DESC LIMIT ?`)
    .all(...params, Math.max(1, Math.min(1000, limit))) as CronRunRow[];

  process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
}

/** should-run <job-name> --window today|this-hour */
function actionShouldRun(
  db: SqliteDB,
  positional: string[],
  flags: Record<string, string | true>,
): void {
  const jobName = positional[0]?.trim();
  if (!jobName) {
    process.stderr.write("should-run: job-name required\n");
    process.exit(1);
  }

  const window = flagStr(flags, "window");
  if (window !== "today" && window !== "this-hour") {
    process.stderr.write("should-run: --window must be 'today' or 'this-hour'\n");
    process.exit(1);
  }

  const now = Date.now();
  let windowStartMs: number;
  if (window === "today") {
    const d = new Date(now);
    windowStartMs = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  } else {
    // this-hour: floor to current hour boundary
    windowStartMs = Math.floor(now / 3_600_000) * 3_600_000;
  }

  const row = db
    .prepare(
      `SELECT run_id FROM cron_runs
       WHERE job_name = ? AND status = 'ok' AND started_at >= ?
       LIMIT 1`,
    )
    .get(jobName, windowStartMs) as { run_id: string } | undefined | null;

  if (row) {
    process.stdout.write(
      JSON.stringify({ shouldRun: false, reason: `already succeeded this ${window}` }) + "\n",
    );
    process.exit(1); // exit 1 = skip
  } else {
    process.stdout.write(
      JSON.stringify({ shouldRun: true, reason: `no successful run found this ${window}` }) + "\n",
    );
    process.exit(0); // exit 0 = proceed
  }
}

/** cleanup-stale [--max-age-hours <n>] */
function actionCleanupStale(
  db: SqliteDB,
  _positional: string[],
  flags: Record<string, string | true>,
): void {
  const maxAgeHours = flagNum(flags, "max-age-hours", 2);
  const now = Date.now();
  const staleThreshold = now - maxAgeHours * 60 * 60 * 1000;

  const result = db
    .prepare(
      `UPDATE cron_runs
       SET status = 'error', finished_at = ?, error = 'stale: exceeded max age',
           duration_ms = ? - started_at
       WHERE status = 'running' AND started_at < ?`,
    )
    .run(now, now, staleThreshold);

  process.stdout.write(JSON.stringify({ cleaned: result.changes ?? 0 }) + "\n");
}

type FailureRow = {
  job_name: string;
  count: number;
  last_error: string | null;
  last_started_at: number;
};

/** check-failures [--window-hours <n>] [--threshold <n>] */
function actionCheckFailures(
  db: SqliteDB,
  _positional: string[],
  flags: Record<string, string | true>,
): void {
  const windowHours = flagNum(flags, "window-hours", 6);
  const threshold = flagNum(flags, "threshold", 3);
  const now = Date.now();
  const windowStartMs = now - windowHours * 60 * 60 * 1000;

  const rows = db
    .prepare(
      `SELECT job_name,
              COUNT(*) AS count,
              MAX(error) AS last_error,
              MAX(started_at) AS last_started_at
       FROM cron_runs
       WHERE status = 'error' AND started_at >= ?
       GROUP BY job_name
       HAVING COUNT(*) >= ?
       ORDER BY COUNT(*) DESC`,
    )
    .all(windowStartMs, threshold) as FailureRow[];

  const failures = rows.map((r) => ({
    job: r.job_name,
    count: r.count,
    lastError: r.last_error ?? null,
    lastStartedAt: r.last_started_at,
    lastStartedAtIso: new Date(r.last_started_at).toISOString(),
  }));

  process.stdout.write(JSON.stringify({ failures, hasAlert: failures.length > 0 }, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function resolveDbPath(flags: Record<string, string | true>): string {
  return (
    flagStr(flags, "db") ??
    process.env.OPENCLAW_CRON_LOG_DB ??
    path.join(os.homedir(), ".openclaw", "cron-log.db")
  );
}

function usageAndExit(): never {
  process.stderr.write(
    [
      "Usage: bun scripts/cron-log-db.ts <action> [options]",
      "",
      "Actions:",
      "  log-start  <job-name> [--pid <n>]",
      "  log-end    <run-id> <status> [--summary <s>] [--error <e>]",
      "  query      [--job <name>] [--status <s>] [--from <iso>] [--to <iso>] [--limit <n>]",
      "  should-run <job-name> --window today|this-hour",
      "  cleanup-stale [--max-age-hours <n>]",
      "  check-failures [--window-hours <n>] [--threshold <n>]",
      "",
      "Options:",
      "  --db <path>   SQLite DB path (default: ~/.openclaw/cron-log.db)",
      "                Also: OPENCLAW_CRON_LOG_DB env var",
    ].join("\n") + "\n",
  );
  process.exit(1);
}

function main(): void {
  const { action, positional, flags } = parseArgs(process.argv);

  if (!action || action === "--help" || action === "-h") {
    usageAndExit();
  }

  const dbPath = resolveDbPath(flags);
  const db = openDb(dbPath);

  try {
    switch (action) {
      case "log-start":
        actionLogStart(db, positional, flags);
        break;
      case "log-end":
        actionLogEnd(db, positional, flags);
        break;
      case "query":
        actionQuery(db, positional, flags);
        break;
      case "should-run":
        actionShouldRun(db, positional, flags);
        break;
      case "cleanup-stale":
        actionCleanupStale(db, positional, flags);
        break;
      case "check-failures":
        actionCheckFailures(db, positional, flags);
        break;
      default:
        process.stderr.write(`Unknown action: ${action}\n`);
        usageAndExit();
    }
  } finally {
    db.close();
  }
}

main();
