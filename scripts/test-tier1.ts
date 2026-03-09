#!/usr/bin/env bun
/**
 * Tier 1 test runner — nightly, no LLM calls, free.
 *
 * Runs the full unit/integration test suite and reports failures.
 * Intended for nightly cron at 02:00.
 *
 * Usage:
 *   bun scripts/test-tier1.ts [--verbose]
 *
 * Env vars:
 *   TEST_CHANNEL     Messaging target for failure alerts
 */

import { execSync } from "node:child_process";

const verbose = process.argv.includes("--verbose");

function log(...args: unknown[]) {
  if (verbose) {
    console.log("[test-tier1]", ...args);
  }
}

function sendAlert(channel: string, message: string) {
  try {
    execSync(
      `openclaw message send --to ${JSON.stringify(channel)} --message ${JSON.stringify(message)}`,
      { stdio: "pipe" },
    );
  } catch {
    // best effort — don't mask the original error
  }
}

async function main() {
  const channel = process.env.TEST_CHANNEL;
  log("starting tier-1 tests (pnpm test)");

  try {
    execSync("OPENCLAW_TEST_PROFILE=low pnpm test --reporter=verbose 2>&1", {
      stdio: "inherit",
      encoding: "utf8",
    });
    log("all tests passed");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const alert = `Tier 1 tests FAILED (nightly):\n${msg.slice(0, 800)}`;
    console.error("[test-tier1] failure:", msg.slice(0, 400));
    if (channel) {
      sendAlert(channel, alert);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("[test-tier1] fatal:", msg);
  const channel = process.env.TEST_CHANNEL;
  if (channel) {
    sendAlert(channel, `Tier 1 test runner FATAL: ${msg}`);
  }
  process.exit(1);
});
