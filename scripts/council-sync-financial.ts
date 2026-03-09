#!/usr/bin/env bun
/**
 * BI Council — financial data import (run manually or via cron after exports).
 *
 * Imports financial data from CSV/JSON exports into the BI database for the
 * CFO and RevenueGuardian experts.
 *
 * Usage:
 *   bun scripts/council-sync-financial.ts [--dry-run] [--verbose]
 *   COUNCIL_FINANCIAL_FILE=/path/to/export.csv bun scripts/council-sync-financial.ts
 *
 * Env vars:
 *   COUNCIL_FINANCIAL_FILE  Path to your financial export file (CSV or JSON)
 *   COUNCIL_DB_DIR          Override DB directory
 *
 * Supported formats (fill in the TODO section below):
 *   - QuickBooks export (CSV)
 *   - Xero export (CSV/JSON)
 *   - Stripe revenue export (CSV)
 *   - Any tabular financial export
 *
 * Example CSV format expected (first row = headers):
 *   date,category,amount,description,account
 *   2026-03-01,Revenue,50000,Enterprise deal ACME,Stripe
 */

import fs from "node:fs";
import path from "node:path";
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
    console.log("[council-sync-financial]", ...args);
  }
}

async function fetchRecords(): Promise<SyncRecord[]> {
  const filePath = process.env.COUNCIL_FINANCIAL_FILE?.trim();
  if (!filePath) {
    console.warn(
      "[council-sync-financial] COUNCIL_FINANCIAL_FILE not set — skipping. " +
        "Set this to the path of your financial export file (CSV or JSON).",
    );
    return [];
  }

  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    console.warn(`[council-sync-financial] File not found: ${resolvedPath}`);
    return [];
  }

  const ext = path.extname(resolvedPath).toLowerCase();
  const content = fs.readFileSync(resolvedPath, "utf8");

  if (ext === ".json") {
    return parseJsonExport(content, resolvedPath);
  }

  if (ext === ".csv") {
    return parseCsvExport(content);
  }

  // TODO: Add support for additional formats (XLSX, QBO, etc.) as needed.
  console.warn(`[council-sync-financial] Unsupported file extension: ${ext}. Use .csv or .json`);
  return [];
}

/** Parse a JSON export — expects an array of transaction objects. */
function parseJsonExport(content: string, filePath: string): SyncRecord[] {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    console.warn("[council-sync-financial] Failed to parse JSON export");
    return [];
  }

  const items = Array.isArray(data) ? data : [data];
  return items.map((item, i) => ({
    source: "financial",
    dataType: "transaction",
    contentJson: JSON.stringify(item),
    // Use a stable ID: file path hash + index (re-import is idempotent)
    sourceId: `${filePath}-${i}`,
  }));
}

/** Parse a simple CSV export (first row = headers, subsequent rows = data). */
function parseCsvExport(content: string): SyncRecord[] {
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    return [];
  }

  const headers = lines[0].split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
  const records: SyncRecord[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(",").map((v) => v.trim().replace(/^"|"$/g, ""));
    const obj: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      obj[headers[j]] = values[j] ?? "";
    }
    // Use date + description + amount as a stable source ID for dedup.
    const sourceId = `csv-${i}-${obj.date ?? ""}-${obj.amount ?? ""}`.replace(/\s+/g, "");
    records.push({
      source: "financial",
      dataType: "transaction",
      contentJson: JSON.stringify(obj),
      sourceId,
    });
  }

  return records;
}

async function main(): Promise<void> {
  const dbDir = resolveBiDbDir();
  const db = openBiDb(dbDir);
  if (!db) {
    console.warn("[council-sync-financial] SQLite unavailable — skipping.");
    process.exit(0);
  }

  const records = await fetchRecords();
  log(`Parsed ${records.length} financial records`);

  if (!dryRun) {
    for (const rec of records) {
      upsertSyncData(db, rec);
    }
  } else {
    log("--dry-run: not writing to DB");
  }

  console.log(`[council-sync-financial] synced ${records.length} records`);
}

main().catch((err) => {
  console.error("[council-sync-financial] Fatal:", err);
  process.exit(1);
});
