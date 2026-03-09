#!/usr/bin/env bun
/**
 * BI Council — project management sync (runs every 4 hours via cron).
 *
 * Pulls issues, tasks, and project activity from your project management tool
 * and stores them for the OperationsAnalyst expert.
 *
 * Usage:
 *   bun scripts/council-sync-projects.ts [--dry-run] [--verbose]
 *
 * Env vars:
 *   COUNCIL_PROJECTS_TOKEN     API token for your PM tool
 *   COUNCIL_PROJECTS_ENDPOINT  Base URL (optional, tool-specific)
 *   COUNCIL_PROJECTS_TEAM      Team/workspace ID (optional)
 *   COUNCIL_DB_DIR             Override DB directory
 *
 * Supported platforms (fill in the TODO section below):
 *   - Linear: https://studio.apollographql.com/public/Linear-API
 *   - Jira: https://developer.atlassian.com/cloud/jira/platform/rest/v3/
 *   - GitHub Issues: https://docs.github.com/en/rest/issues
 *   - Asana, Notion, ClickUp, etc.
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
    console.log("[council-sync-projects]", ...args);
  }
}

async function fetchRecords(): Promise<SyncRecord[]> {
  const token = process.env.COUNCIL_PROJECTS_TOKEN?.trim();
  if (!token) {
    console.warn(
      "[council-sync-projects] COUNCIL_PROJECTS_TOKEN not set — skipping. " +
        "Set this to your project management API token to enable project sync.",
    );
    return [];
  }

  const endpoint = process.env.COUNCIL_PROJECTS_ENDPOINT?.trim();
  const teamId = process.env.COUNCIL_PROJECTS_TEAM?.trim();

  // TODO: Replace this section with your project management API calls.
  //
  // Example for Linear (GraphQL):
  //
  //   const query = `{ issues(first: 100, filter: { updatedAt: { gte: "${since.toISOString()}" } }) {
  //     nodes { id title state { name } assignee { name } priority updatedAt }
  //   }}`;
  //   const res = await fetch("https://api.linear.app/graphql", {
  //     method: "POST",
  //     headers: { Authorization: token, "Content-Type": "application/json" },
  //     body: JSON.stringify({ query }),
  //   });
  //   const { data } = await res.json();
  //   return data.issues.nodes.map((issue) => ({
  //     source: "projects",
  //     dataType: "issue",
  //     contentJson: JSON.stringify({ title: issue.title, state: issue.state.name, priority: issue.priority }),
  //     sourceId: issue.id,
  //   }));
  //
  // Example for GitHub Issues:
  //
  //   const url = `https://api.github.com/repos/${owner}/${repo}/issues?state=all&since=${since.toISOString()}&per_page=100`;
  //   const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  //   const issues = await res.json();
  //   return issues.map((issue) => ({
  //     source: "projects",
  //     dataType: "issue",
  //     contentJson: JSON.stringify({ title: issue.title, state: issue.state, labels: issue.labels.map(l => l.name) }),
  //     sourceId: String(issue.id),
  //   }));

  log(`endpoint=${endpoint ?? "(none)"} team=${teamId ?? "(none)"}`);
  return [];
}

async function main(): Promise<void> {
  const dbDir = resolveBiDbDir();
  const db = openBiDb(dbDir);
  if (!db) {
    console.warn("[council-sync-projects] SQLite unavailable — skipping.");
    process.exit(0);
  }

  const records = await fetchRecords();
  log(`Fetched ${records.length} project records`);

  if (!dryRun) {
    for (const rec of records) {
      upsertSyncData(db, rec);
    }
  } else {
    log("--dry-run: not writing to DB");
  }

  console.log(`[council-sync-projects] synced ${records.length} records`);
}

main().catch((err) => {
  console.error("[council-sync-projects] Fatal:", err);
  process.exit(1);
});
