#!/usr/bin/env bun
/**
 * Security review — daily cron script.
 *
 * Multi-perspective analysis: offensive, defensive, data privacy, operational.
 * Scans error patterns for auth/permission/leak signals and runs pnpm audit.
 *
 * Usage:
 *   bun scripts/review-security.ts [--dry-run] [--verbose]
 *
 * Env vars:
 *   REVIEW_CHANNEL   Messaging target for the summary
 *   OPENCLAW_HOME    Override for ~/.openclaw (optional)
 */

import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const verbose = process.argv.includes("--verbose");
const dryRun = process.argv.includes("--dry-run");

function log(...args: unknown[]) {
  if (verbose) {
    console.log("[security-review]", ...args);
  }
}

function resolveAgentSessionsDir(): string {
  const home = process.env.OPENCLAW_HOME ?? path.join(os.homedir(), ".openclaw");
  return path.join(home, "agents", "main", "sessions");
}

// Security-relevant error pattern keywords.
const AUTH_PATTERNS = [
  "401",
  "403",
  "unauthorized",
  "forbidden",
  "permission denied",
  "invalid token",
  "expired token",
  "EACCES",
  "authentication failed",
  "api key",
  "secret",
  "credential",
];

function isAuthPattern(pattern: string): boolean {
  const lower = pattern.toLowerCase();
  return AUTH_PATTERNS.some((kw) => lower.includes(kw));
}

async function runAudit(): Promise<{ summary: string; criticalCount: number; highCount: number }> {
  try {
    const output = execSync("pnpm audit --json 2>/dev/null", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const report = JSON.parse(output) as {
      metadata?: {
        vulnerabilities?: { critical?: number; high?: number; moderate?: number; low?: number };
      };
    };
    const v = report?.metadata?.vulnerabilities ?? {};
    const critical = v.critical ?? 0;
    const high = v.high ?? 0;
    return {
      summary: `audit: ${critical} critical, ${high} high, ${v.moderate ?? 0} moderate, ${v.low ?? 0} low`,
      criticalCount: critical,
      highCount: high,
    };
  } catch {
    return { summary: "pnpm audit: unavailable or failed", criticalCount: 0, highCount: 0 };
  }
}

async function main() {
  const channel = process.env.REVIEW_CHANNEL;

  const sessionsDir = resolveAgentSessionsDir();
  log("sessions dir:", sessionsDir);

  const { openLearningsDb, queryErrorPatterns } =
    await import("../src/agents/tools/learnings-store-sqlite.js");

  const db = openLearningsDb(sessionsDir);
  if (!db) {
    console.warn("[security-review] SQLite unavailable — skipping");
    process.exit(0);
  }

  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const allErrors = queryErrorPatterns(db, { minCount: 1, limit: 100 });
  const recentAuth = allErrors.filter(
    (r) => r.last_seen >= sevenDaysAgo && isAuthPattern(r.pattern),
  );

  const audit = await runAudit();
  log(audit.summary);

  const lines: string[] = [];
  lines.push("*Security Review*");
  lines.push(`Date: ${new Date().toISOString().slice(0, 10)}`);
  lines.push("");

  // Offensive perspective
  lines.push("Offensive: auth/permission errors in last 7d:");
  if (recentAuth.length === 0) {
    lines.push("  None detected");
  } else {
    for (const e of recentAuth.slice(0, 5)) {
      lines.push(`  • ${e.pattern} — ${e.count} hits`);
    }
  }
  lines.push("");

  // Defensive perspective
  lines.push(`Defensive: ${audit.summary}`);
  if (audit.criticalCount > 0 || audit.highCount > 0) {
    lines.push(`  ⚠ Run \`pnpm audit --fix\` or review advisories`);
  }
  lines.push("");

  // Data privacy perspective
  const leakPatterns = allErrors.filter((r) =>
    /pii|email|phone|personal|leak|exfil/i.test(r.pattern),
  );
  lines.push(`Data privacy: PII-related patterns: ${leakPatterns.length}`);
  for (const p of leakPatterns.slice(0, 3)) {
    lines.push(`  • ${p.pattern}`);
  }
  lines.push("");

  // Operational perspective
  lines.push("Operational: action items");
  const items: string[] = [];
  if (recentAuth.length > 0) {
    items.push("Rotate or inspect tokens referenced in auth errors");
  }
  if (audit.criticalCount > 0) {
    items.push(`Fix ${audit.criticalCount} critical npm advisory/ies`);
  }
  if (items.length === 0) {
    items.push("No action items");
  }
  for (const item of items) {
    lines.push(`  • ${item}`);
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
      console.error("[security-review] failed to send:", msg);
      process.exit(1);
    }
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("[security-review] fatal:", msg);
  const channel = process.env.REVIEW_CHANNEL;
  if (channel) {
    try {
      execSync(
        `openclaw message send --to ${JSON.stringify(channel)} --message ${JSON.stringify(`Security review FAILED: ${msg}`)}`,
        { stdio: "pipe" },
      );
    } catch {
      // ignore
    }
  }
  process.exit(1);
});
