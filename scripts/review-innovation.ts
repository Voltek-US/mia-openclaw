#!/usr/bin/env bun
/**
 * Innovation scout — daily cron script.
 *
 * Surfaces open feature requests and recent insights from the learnings DB,
 * proposes top ideas, and sends them to REVIEW_CHANNEL for accept/reject.
 *
 * Usage:
 *   bun scripts/review-innovation.ts [--dry-run] [--verbose]
 *
 * Env vars:
 *   REVIEW_CHANNEL   Messaging target for the proposals
 *   OPENCLAW_HOME    Override for ~/.openclaw (optional)
 */

import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const verbose = process.argv.includes("--verbose");
const dryRun = process.argv.includes("--dry-run");

function log(...args: unknown[]) {
  if (verbose) {
    console.log("[innovation-scout]", ...args);
  }
}

function resolveAgentSessionsDir(): string {
  const home = process.env.OPENCLAW_HOME ?? path.join(os.homedir(), ".openclaw");
  return path.join(home, "agents", "main", "sessions");
}

async function main() {
  const channel = process.env.REVIEW_CHANNEL;

  const sessionsDir = resolveAgentSessionsDir();
  log("sessions dir:", sessionsDir);

  const { openLearningsDb, queryFeatureRequests, queryLearnings } =
    await import("../src/agents/tools/learnings-store-sqlite.js");

  const db = openLearningsDb(sessionsDir);
  if (!db) {
    console.warn("[innovation-scout] SQLite unavailable — skipping");
    process.exit(0);
  }

  const features = queryFeatureRequests(db, { status: "open", limit: 10 });
  const insights = queryLearnings(db, { category: "insight", limit: 10 });

  const lines: string[] = [];
  lines.push("*Innovation Scout*");
  lines.push(`Date: ${new Date().toISOString().slice(0, 10)}`);
  lines.push("");

  if (features.length === 0 && insights.length === 0) {
    lines.push("No open feature requests or recent insights. Nothing to propose.");
  } else {
    const proposals = [
      ...features.slice(0, 3).map((f) => ({ title: f.title, source: "feature_request" })),
      ...insights.slice(0, 3).map((i) => ({
        title: i.content.slice(0, 80).replace(/\n/g, " "),
        source: "insight",
      })),
    ].slice(0, 3);

    lines.push(`Top proposals (${proposals.length}):`);
    proposals.forEach((p, i) => {
      lines.push(`${i + 1}. [${p.source}] ${p.title}`);
    });
    lines.push("");
    lines.push("Reply 'accept N' or 'reject N' for each idea.");
  }

  if (features.length > 0) {
    lines.push("");
    lines.push(`Open feature requests: ${features.length} total`);
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
        { stdio: "inherit" },
      );
      log("report sent to", channel);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[innovation-scout] failed to send:", msg);
      process.exit(1);
    }
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("[innovation-scout] fatal:", msg);
  const channel = process.env.REVIEW_CHANNEL;
  if (channel) {
    try {
      execSync(
        `openclaw message send --to ${JSON.stringify(channel)} --message ${JSON.stringify(`Innovation scout FAILED: ${msg}`)}`,
        { stdio: "pipe" },
      );
    } catch {
      // ignore
    }
  }
  process.exit(1);
});
