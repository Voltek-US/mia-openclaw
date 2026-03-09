#!/usr/bin/env bun
/**
 * Tier 3 test runner — weekly (Saturday 04:00), moderate cost, full e2e.
 *
 * Runs the complete live test suite including messaging platform round-trips.
 * Requires LIVE=1 plus all provider credentials.
 *
 * Usage:
 *   bun scripts/test-tier3.ts [--verbose]
 *
 * Env vars:
 *   TEST_CHANNEL   Messaging target for failure alerts
 *   LIVE           Must be "1" (auto-set by this script)
 */

import { execSync } from "node:child_process";

const verbose = process.argv.includes("--verbose");

function log(...args: unknown[]) {
  if (verbose) {
    console.log("[test-tier3]", ...args);
  }
}

function sendAlert(channel: string, message: string) {
  try {
    execSync(
      `openclaw message send --to ${JSON.stringify(channel)} --message ${JSON.stringify(message)}`,
      { stdio: "pipe" },
    );
  } catch {
    // best effort
  }
}

async function main() {
  const channel = process.env.TEST_CHANNEL;
  log("starting tier-3 tests (full e2e + messaging round-trips)");

  try {
    execSync("LIVE=1 pnpm test:live 2>&1", {
      stdio: "inherit",
      encoding: "utf8",
    });
    log("tier-3 tests passed");
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    // Extract failing e2e test names from output.
    const failLines = raw
      .split("\n")
      .filter((l) => /FAIL|✗|×|e2e/.test(l))
      .slice(0, 10)
      .join("\n");
    const alert = `Tier 3 tests FAILED (weekly full e2e):\n${failLines || raw.slice(0, 600)}`;
    console.error("[test-tier3] failure:", raw.slice(0, 400));
    if (channel) {
      sendAlert(channel, alert);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("[test-tier3] fatal:", msg);
  const channel = process.env.TEST_CHANNEL;
  if (channel) {
    sendAlert(channel, `Tier 3 test runner FATAL: ${msg}`);
  }
  process.exit(1);
});
