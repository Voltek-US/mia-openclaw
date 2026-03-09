#!/usr/bin/env bun
/**
 * BI Council — team chat sync (runs every 3 hours via cron).
 *
 * Pulls recent messages/activity from your team chat platform and stores
 * them in the BI SQLite database for expert analysis.
 *
 * Usage:
 *   bun scripts/council-sync-chat.ts [--dry-run] [--verbose]
 *
 * Env vars:
 *   COUNCIL_CHAT_TOKEN     API token for your team chat (Slack, Discord, etc.)
 *   COUNCIL_CHAT_ENDPOINT  Base URL for the chat API (optional, platform-specific)
 *   COUNCIL_CHAT_CHANNEL   Channel/room ID to pull messages from (optional)
 *   COUNCIL_DB_DIR         Override DB directory (default: ~/.openclaw/intelligence)
 *
 * Supported platforms (fill in the TODO section below):
 *   - Slack: https://api.slack.com/methods/conversations.history
 *   - Discord: https://discord.com/developers/docs/resources/channel
 *   - Microsoft Teams: https://learn.microsoft.com/en-us/graph/api/chat-list
 *   - Any platform with an HTTP API
 */

import { openBiDb, resolveBiDbDir, type SyncRecord } from "../src/intelligence/bi-store.js";

const verbose = process.argv.includes("--verbose");
const dryRun = process.argv.includes("--dry-run");

function log(...args: unknown[]) {
  if (verbose) {
    console.log("[council-sync-chat]", ...args);
  }
}

async function fetchRecords(): Promise<SyncRecord[]> {
  const token = process.env.COUNCIL_CHAT_TOKEN?.trim();
  if (!token) {
    console.warn(
      "[council-sync-chat] COUNCIL_CHAT_TOKEN not set — skipping. " +
        "Set this to your team chat API token to enable chat sync.",
    );
    return [];
  }

  const endpoint = process.env.COUNCIL_CHAT_ENDPOINT?.trim();
  const channelId = process.env.COUNCIL_CHAT_CHANNEL?.trim();

  // TODO: Replace this section with your team chat API calls.
  //
  // Example for Slack conversations.history:
  //
  //   const url = `https://slack.com/api/conversations.history?channel=${channelId}&limit=200`;
  //   const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  //   const data = await res.json() as { messages?: SlackMessage[]; ok: boolean };
  //   if (!data.ok) throw new Error(`Slack API error`);
  //   return (data.messages ?? []).map((msg) => ({
  //     source: "chat",
  //     dataType: "message",
  //     contentJson: JSON.stringify({ text: msg.text, user: msg.user, ts: msg.ts }),
  //     sourceId: msg.ts,  // Slack uses timestamp as message ID
  //   }));
  //
  // Example for Discord channel messages:
  //
  //   const url = `https://discord.com/api/v10/channels/${channelId}/messages?limit=100`;
  //   const res = await fetch(url, { headers: { Authorization: `Bot ${token}` } });
  //   const messages = await res.json() as DiscordMessage[];
  //   return messages.map((msg) => ({
  //     source: "chat",
  //     dataType: "message",
  //     contentJson: JSON.stringify({ content: msg.content, author: msg.author?.username, id: msg.id }),
  //     sourceId: msg.id,
  //   }));

  log(`endpoint=${endpoint ?? "(none)"} channel=${channelId ?? "(none)"}`);
  // Return empty until the TODO above is filled in.
  return [];
}

async function main(): Promise<void> {
  const dbDir = resolveBiDbDir();
  const db = openBiDb(dbDir);
  if (!db) {
    console.warn("[council-sync-chat] SQLite unavailable — skipping.");
    process.exit(0);
  }

  const { upsertSyncData } = await import("../src/intelligence/bi-store.js");
  const records = await fetchRecords();
  log(`Fetched ${records.length} chat records`);

  if (!dryRun) {
    for (const rec of records) {
      upsertSyncData(db, rec);
    }
  } else {
    log("--dry-run: not writing to DB");
  }

  console.log(`[council-sync-chat] synced ${records.length} records`);
}

main().catch((err) => {
  console.error("[council-sync-chat] Fatal:", err);
  process.exit(1);
});
