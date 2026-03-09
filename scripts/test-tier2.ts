#!/usr/bin/env bun
/**
 * Tier 2 test runner — weekly (Sunday 03:00), low cost, live LLM calls.
 *
 * Runs live tests with real LLM API keys. Requires CLAWDBOT_LIVE_TEST=1
 * and appropriate API keys in environment.
 *
 * Usage:
 *   bun scripts/test-tier2.ts [--verbose]
 *
 * Env vars:
 *   TEST_CHANNEL          Messaging target for failure alerts
 *   CLAWDBOT_LIVE_TEST    Must be set to "1" (auto-set by this script)
 */

import { execSync } from "node:child_process";

const verbose = process.argv.includes("--verbose");

function log(...args: unknown[]) {
  if (verbose) {
    console.log("[test-tier2]", ...args);
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
  log("starting tier-2 tests (live LLM, pnpm test:live)");

  try {
    execSync("CLAWDBOT_LIVE_TEST=1 pnpm test:live 2>&1", {
      stdio: "inherit",
      encoding: "utf8",
    });
    log("tier-2 tests passed");
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    // Extract first 10 failing test names from output if present.
    const failLines = raw
      .split("\n")
      .filter((l) => /FAIL|✗|×/.test(l))
      .slice(0, 10)
      .join("\n");
    const alert = `Tier 2 tests FAILED (weekly live LLM):\n${failLines || raw.slice(0, 600)}`;
    console.error("[test-tier2] failure:", raw.slice(0, 400));
    if (channel) {
      sendAlert(channel, alert);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("[test-tier2] fatal:", msg);
  const channel = process.env.TEST_CHANNEL;
  if (channel) {
    sendAlert(channel, `Tier 2 test runner FATAL: ${msg}`);
  }
  process.exit(1);
});
