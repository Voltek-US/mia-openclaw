#!/usr/bin/env bun
/**
 * BI Council — nightly run script.
 *
 * Loads synced business signals, runs expert personas in parallel,
 * synthesizes recommendations, and delivers a digest to the configured channel.
 *
 * Usage:
 *   bun scripts/council-run.ts [--dry-run] [--verbose]
 *
 * Env vars:
 *   COUNCIL_CHANNEL        Messaging target (required for delivery)
 *   COUNCIL_DB_DIR         Override DB directory (default: ~/.openclaw/intelligence)
 *   COUNCIL_LOOKBACK_DAYS  Days of signal history to include (default: 3)
 *   COUNCIL_SKIP_LLM       Set to "1" to skip LLM calls and return stub data (testing)
 *   OPENCLAW_HOME          Override ~/.openclaw base directory
 */

import { openBiDb, resolveBiDbDir } from "../src/intelligence/bi-store.js";
import { runCouncil } from "../src/intelligence/council.js";
import { formatDigest, sendDigest, sendErrorAlert } from "../src/intelligence/delivery.js";

const verbose = process.argv.includes("--verbose");
const dryRun = process.argv.includes("--dry-run");

function log(...args: unknown[]) {
  if (verbose) {
    console.log("[council-run]", ...args);
  }
}

async function main(): Promise<void> {
  const channel = process.env.COUNCIL_CHANNEL?.trim();
  const lookbackDays = parseInt(process.env.COUNCIL_LOOKBACK_DAYS ?? "3", 10);
  const dbDir = resolveBiDbDir();

  log(`DB dir: ${dbDir}`);
  log(`Channel: ${channel ?? "(not set — delivery skipped)"}`);
  log(`Lookback: ${lookbackDays} days, dryRun: ${dryRun}`);

  const db = openBiDb(dbDir);
  if (!db) {
    console.error("[council-run] SQLite unavailable — cannot run council.");
    process.exit(0);
  }

  let result;
  try {
    result = await runCouncil(db, { verbose, dryRun, lookbackDays });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[council-run] Council run failed:", msg);
    if (channel && !dryRun) {
      sendErrorAlert(channel, `Council run error: ${msg}`);
    }
    process.exit(1);
  }

  const { runId, expertAnalyses, recommendations, runDurationMs, skippedExperts } = result;

  console.log(
    `[council-run] Run ${runId} complete — ${expertAnalyses.length} experts, ` +
      `${recommendations.length} recommendations, ${(runDurationMs / 1000).toFixed(1)}s`,
  );
  if (skippedExperts.length > 0) {
    console.warn(`[council-run] Skipped experts: ${skippedExperts.join(", ")}`);
  }

  if (dryRun) {
    console.log("[council-run] --dry-run: printing digest to stdout, skipping delivery.");
    const digest = formatDigest(runId, db);
    console.log("\n" + digest);
    return;
  }

  if (!channel) {
    console.warn(
      "[council-run] COUNCIL_CHANNEL not set — digest not delivered. Set it to enable delivery.",
    );
    return;
  }

  const digest = formatDigest(runId, db);
  log("Sending digest...");
  sendDigest(digest, channel);
  console.log(`[council-run] Digest delivered to ${channel}`);
}

main().catch((err) => {
  console.error("[council-run] Fatal:", err);
  process.exit(1);
});
