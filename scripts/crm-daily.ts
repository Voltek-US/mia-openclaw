#!/usr/bin/env bun
/**
 * CRM Daily Pipeline
 *
 * Scans the last 24h of email/calendar activity, updates contacts,
 * refreshes relationship scores and summaries, and delivers a digest.
 *
 * Usage:
 *   bun scripts/crm-daily.ts [--dry-run] [--verbose]
 *
 * Options:
 *   --dry-run    Skip DB writes and channel delivery; print digest to stdout
 *   --verbose    Print detailed progress
 *
 * Env:
 *   CRM_CHANNEL          Messaging channel for digest delivery
 *   CRM_DB_DIR           Override CRM database directory
 *   CRM_ACCOUNT          Email account address (required for scanning)
 *   CRM_MS365_TOKEN      MS365 OAuth access token
 *   CRM_INTERNAL_DOMAINS Comma-separated internal domains to skip
 *   CRM_SKIP_LLM         Set to "1" to skip LLM calls (testing)
 *
 * Cron example (daily at 7am):
 *   0 7 * * * cd /path/to/openclaw && CRM_CHANNEL="@you" bun scripts/crm-daily.ts
 */

import {
  formatCrmDailyDigest,
  sendCrmDigest,
  sendCrmErrorAlert,
} from "../src/intelligence/crm/delivery.js";
import {
  processDiscoveredContact,
  resolveEmailAdapter,
} from "../src/intelligence/crm/discovery.js";
import { refreshStaleSummaries } from "../src/intelligence/crm/profiler.js";
import { buildInteractionCountMap, refreshAllScores } from "../src/intelligence/crm/scorer.js";
import { openCrmDb, resolveCrmDbDir, isAutoAddEnabled } from "../src/intelligence/crm/store.js";

// ============================================================================
// Argument parsing
// ============================================================================

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const verbose = args.has("--verbose");

function log(...parts: unknown[]): void {
  if (verbose) {
    console.log("[crm-daily]", ...parts);
  }
}

// ============================================================================
// Config
// ============================================================================

const channel = process.env.CRM_CHANNEL?.trim();
const account = process.env.CRM_ACCOUNT?.trim() ?? "";
const ms365Token = process.env.CRM_MS365_TOKEN;
const internalDomains = (process.env.CRM_INTERNAL_DOMAINS ?? "").split(",").filter(Boolean);

// ============================================================================
// Main
// ============================================================================

const errors: string[] = [];
const stats = { added: 0, queued: 0, skipped: 0, summariesRefreshed: 0, scoresRefreshed: 0 };

log("Opening CRM database…");
const dbDir = resolveCrmDbDir();
const db = openCrmDb(dbDir);

if (!db) {
  console.error("[crm-daily] SQLite unavailable — node:sqlite requires Node.js 22+.");
  process.exit(1);
}

log(`CRM database: ${dbDir}/crm.sqlite`);

// ---------------------------------------------------------------------------
// Step 1: Discover new contacts from email + calendar
// ---------------------------------------------------------------------------

if (account) {
  log("Resolving email adapter…");
  let adapter;
  try {
    adapter = resolveEmailAdapter({ account, ms365AccessToken: ms365Token });
    log(`  Adapter: ${adapter.constructor.name}`);
  } catch (err) {
    const msg = `Adapter resolution failed: ${String(err)}`;
    errors.push(msg);
    console.error("[crm-daily]", msg);
  }

  if (adapter) {
    log("Scanning email (last 24h)…");
    try {
      const discovered = await adapter.scanRecentEmails(24);
      log(`  Found ${discovered.length} email contacts`);
      const autoAddMode = isAutoAddEnabled(db);
      for (const c of discovered) {
        if (!dryRun) {
          const result = processDiscoveredContact(db, c, {
            internalDomains,
            autoAddMode,
            autoAddThreshold: 50,
          });
          if (result === "added") {
            stats.added++;
          } else if (result === "queued") {
            stats.queued++;
          } else {
            stats.skipped++;
          }
        } else {
          stats.skipped++;
        }
      }
      log(`  Added: ${stats.added}  Queued: ${stats.queued}  Skipped: ${stats.skipped}`);
    } catch (err) {
      const msg = `Email scan error: ${String(err)}`;
      errors.push(msg);
      console.error("[crm-daily]", msg);
    }

    log("Scanning calendar (last 24h)…");
    try {
      const calContacts = await adapter.scanCalendar(24);
      log(`  Found ${calContacts.length} calendar contacts`);
      if (!dryRun) {
        const autoAddMode = isAutoAddEnabled(db);
        for (const c of calContacts) {
          const result = processDiscoveredContact(db, c, {
            internalDomains,
            autoAddMode,
            autoAddThreshold: 50,
          });
          if (result === "added") {
            stats.added++;
          } else if (result === "queued") {
            stats.queued++;
          } else {
            stats.skipped++;
          }
        }
      }
    } catch (err) {
      const msg = `Calendar scan error: ${String(err)}`;
      errors.push(msg);
      console.error("[crm-daily]", msg);
    }
  }
} else {
  log("CRM_ACCOUNT not set — skipping email/calendar scan.");
}

// ---------------------------------------------------------------------------
// Step 2: Refresh relationship scores
// ---------------------------------------------------------------------------

log("Refreshing relationship scores…");
if (!dryRun) {
  const counts = buildInteractionCountMap(db);
  refreshAllScores(db, counts);
  stats.scoresRefreshed = counts.size;
  log(`  Refreshed ${stats.scoresRefreshed} contact scores`);
}

// ---------------------------------------------------------------------------
// Step 3: Refresh stale contact summaries (up to 10 per run)
// ---------------------------------------------------------------------------

log("Refreshing stale contact summaries…");
if (!dryRun) {
  try {
    stats.summariesRefreshed = await refreshStaleSummaries(db, { limit: 10 });
    log(`  Refreshed ${stats.summariesRefreshed} summaries`);
  } catch (err) {
    const msg = `Summary refresh error: ${String(err)}`;
    errors.push(msg);
    console.error("[crm-daily]", msg);
  }
}

// ---------------------------------------------------------------------------
// Step 4: Format and deliver digest
// ---------------------------------------------------------------------------

const digest = formatCrmDailyDigest(db, {
  ...stats,
  errors,
  runDate: new Date(),
});

if (dryRun) {
  console.log("\n--- CRM daily digest preview ---\n" + digest);
  process.exit(0);
}

if (!channel) {
  console.warn("[crm-daily] CRM_CHANNEL not set — digest not delivered.");
  console.log(digest);
  process.exit(0);
}

if (errors.length > 0 && stats.added === 0 && stats.queued === 0) {
  sendCrmErrorAlert(channel, `Run failed with ${errors.length} error(s): ${errors[0]}`);
} else {
  sendCrmDigest(digest, channel);
  console.log(`[crm-daily] Digest delivered to ${channel}`);
}
