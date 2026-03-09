#!/usr/bin/env bun
/**
 * BI Council — CRM / sales pipeline sync (runs every 4 hours via cron).
 *
 * Pulls deals, contacts, and pipeline activity from your CRM for the
 * RevenueGuardian, GrowthStrategist, MarketAnalyst, and CFO experts.
 *
 * Usage:
 *   bun scripts/council-sync-crm.ts [--dry-run] [--verbose]
 *
 * Env vars:
 *   COUNCIL_CRM_TOKEN     API token for your CRM
 *   COUNCIL_CRM_ENDPOINT  Base URL (optional, CRM-specific)
 *   COUNCIL_DB_DIR        Override DB directory
 *
 * Supported platforms (fill in the TODO section below):
 *   - HubSpot: https://developers.hubspot.com/docs/api/crm/deals
 *   - Salesforce: https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta
 *   - Pipedrive: https://developers.pipedrive.com/docs/api/v1
 *   - Close, Attio, Folk, etc.
 */

import {
  openBiDb,
  resolveBiDbDir,
  upsertSyncData,
  type SyncRecord,
} from "../src/intelligence/bi-store.js";

const verbose = process.argv.includes("--verbose");
const dryRun = process.argv.includes("--dry-run");

function log(...args: unknown[]) {
  if (verbose) {
    console.log("[council-sync-crm]", ...args);
  }
}

async function fetchRecords(): Promise<SyncRecord[]> {
  const token = process.env.COUNCIL_CRM_TOKEN?.trim();
  if (!token) {
    console.warn(
      "[council-sync-crm] COUNCIL_CRM_TOKEN not set — skipping. " +
        "Set this to your CRM API token to enable CRM sync.",
    );
    return [];
  }

  const endpoint = process.env.COUNCIL_CRM_ENDPOINT?.trim();

  // TODO: Replace this section with your CRM API calls.
  //
  // Example for HubSpot deals:
  //
  //   const url = "https://api.hubapi.com/crm/v3/objects/deals?limit=100&properties=dealname,amount,dealstage,closedate,hs_lastmodifieddate";
  //   const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  //   const data = await res.json();
  //   return (data.results ?? []).map((deal) => ({
  //     source: "crm",
  //     dataType: "deal",
  //     contentJson: JSON.stringify({
  //       name: deal.properties.dealname,
  //       amount: deal.properties.amount,
  //       stage: deal.properties.dealstage,
  //       closeDate: deal.properties.closedate,
  //     }),
  //     sourceId: deal.id,
  //   }));
  //
  // Example for Pipedrive deals:
  //
  //   const url = `${endpoint ?? "https://api.pipedrive.com/v1"}/deals?api_token=${token}&limit=200&status=all`;
  //   const res = await fetch(url);
  //   const data = await res.json();
  //   return (data.data ?? []).map((deal) => ({
  //     source: "crm",
  //     dataType: "deal",
  //     contentJson: JSON.stringify({ title: deal.title, value: deal.value, stage: deal.stage_id, status: deal.status }),
  //     sourceId: String(deal.id),
  //   }));

  log(`endpoint=${endpoint ?? "(none)"}`);
  return [];
}

async function main(): Promise<void> {
  const dbDir = resolveBiDbDir();
  const db = openBiDb(dbDir);
  if (!db) {
    console.warn("[council-sync-crm] SQLite unavailable — skipping.");
    process.exit(0);
  }

  const records = await fetchRecords();
  log(`Fetched ${records.length} CRM records`);

  if (!dryRun) {
    for (const rec of records) {
      upsertSyncData(db, rec);
    }
  } else {
    log("--dry-run: not writing to DB");
  }

  console.log(`[council-sync-crm] synced ${records.length} records`);
}

main().catch((err) => {
  console.error("[council-sync-crm] Fatal:", err);
  process.exit(1);
});
