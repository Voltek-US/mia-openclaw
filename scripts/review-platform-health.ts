#!/usr/bin/env bun
/**
 * Platform health review — daily cron script.
 *
 * Queries the learnings DB for recurring error patterns and unresolved corrections,
 * then sends a summary to the configured REVIEW_CHANNEL.
 *
 * Usage:
 *   bun scripts/review-platform-health.ts [--dry-run] [--verbose]
 *
 * Env vars:
 *   REVIEW_CHANNEL   Messaging target for the summary (e.g. Telegram user ID or Discord channel)
 *   OPENCLAW_HOME    Override for ~/.openclaw (optional)
 */

import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const verbose = process.argv.includes("--verbose");
const dryRun = process.argv.includes("--dry-run");

function log(...args: unknown[]) {
  if (verbose) {
    console.log("[platform-health]", ...args);
  }
}

function resolveAgentSessionsDir(): string {
  const home = process.env.OPENCLAW_HOME ?? path.join(os.homedir(), ".openclaw");
  return path.join(home, "agents", "main", "sessions");
}

async function main() {
  const channel = process.env.REVIEW_CHANNEL;
  if (!channel) {
    console.warn("[platform-health] REVIEW_CHANNEL not set — summary will only print to stdout");
  }

  const sessionsDir = resolveAgentSessionsDir();
  log("sessions dir:", sessionsDir);

  // Dynamically import the learnings store.
  const { openLearningsDb, queryErrorPatterns, queryLearnings, queryFeatureRequests } =
    await import("../src/agents/tools/learnings-store-sqlite.js");

  const db = openLearningsDb(sessionsDir);
  if (!db) {
    const msg = "[platform-health] SQLite unavailable — skipping health review";
    console.warn(msg);
    process.exit(0);
  }

  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

  // Error patterns seen 3+ times in the last 7 days.
  const allErrors = queryErrorPatterns(db, { minCount: 1, limit: 50 });
  const recentErrors = allErrors.filter((r) => r.last_seen >= sevenDaysAgo && r.count >= 3);

  // Recent uncategorized corrections.
  const corrections = queryLearnings(db, { category: "correction", limit: 10 });

  // Open feature requests.
  const features = queryFeatureRequests(db, { status: "open", limit: 5 });

  // Build report.
  const lines: string[] = [];
  lines.push("*Platform Health Review*");
  lines.push(`Date: ${new Date().toISOString().slice(0, 10)}`);
  lines.push("");

  if (recentErrors.length === 0) {
    lines.push("Error patterns (7d, ≥3 hits): none");
  } else {
    lines.push(`Error patterns (7d, ≥3 hits): ${recentErrors.length}`);
    for (const e of recentErrors.slice(0, 5)) {
      lines.push(`  • ${e.pattern} — ${e.count} hits`);
    }
  }

  lines.push("");

  if (corrections.length === 0) {
    lines.push("Recent corrections: none");
  } else {
    lines.push(`Recent corrections: ${corrections.length}`);
    for (const c of corrections.slice(0, 3)) {
      const preview = c.content.slice(0, 80).replace(/\n/g, " ");
      lines.push(`  • ${preview}`);
    }
  }

  lines.push("");

  if (features.length > 0) {
    lines.push(`Open feature requests: ${features.length}`);
    for (const f of features.slice(0, 3)) {
      lines.push(`  • ${f.title}`);
    }
    lines.push("");
  }

  const report = lines.join("\n");
  console.log(report);

  if (dryRun) {
    log("dry-run: skipping send");
    process.exit(0);
  }

  if (channel) {
    try {
      execSync(
        `openclaw message send --to ${JSON.stringify(channel)} --message ${JSON.stringify(report)}`,
        {
          stdio: "inherit",
        },
      );
      log("report sent to", channel);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[platform-health] failed to send report:", msg);
      process.exit(1);
    }
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("[platform-health] fatal:", msg);

  // Attempt to notify even on fatal error.
  const channel = process.env.REVIEW_CHANNEL;
  if (channel) {
    try {
      execSync(
        `openclaw message send --to ${JSON.stringify(channel)} --message ${JSON.stringify(`Platform health review FAILED: ${msg}`)}`,
        { stdio: "pipe" },
      );
    } catch {
      // ignore send failure
    }
  }
  process.exit(1);
});
