import type { DigestGroup, NotifyQueueEntry, NotifyTier } from "./store.js";
import { fetchPendingByTier, markDelivered } from "./store.js";

// ============================================================================
// Types
// ============================================================================

export interface FlushResult {
  flushed: number;
  digest: DigestGroup[];
}

/** Inject-able delivery function so flush.ts doesn't couple to deliver.ts internals. */
export type DeliverFn = (channel: string, text: string) => Promise<void>;

// ============================================================================
// Flush
// ============================================================================

/**
 * Flush all pending entries for a given tier.
 *
 * Groups messages by (channel, topic), builds a digest per channel,
 * calls deliverFn once per channel, then marks rows as delivered.
 */
export async function flushTier(
  db: import("node:sqlite").DatabaseSync,
  tier: NotifyTier,
  deliverFn: DeliverFn,
): Promise<FlushResult> {
  const pending = fetchPendingByTier(db, tier);
  if (pending.length === 0) {
    return { flushed: 0, digest: [] };
  }

  const groups = groupByChannelTopic(pending);
  const deliveredIds: string[] = [];

  // Deliver one digest per channel (collects all topics for that channel).
  const channelGroups = groupByChannel(groups);
  for (const [channel, channelGroupList] of channelGroups) {
    const text = buildDigest(channelGroupList);
    try {
      await deliverFn(channel, text);
      // Mark all entries in this channel's groups as delivered.
      for (const g of channelGroupList) {
        // Find the original entries to get IDs.
        const entriesForGroup = pending.filter(
          (e) => e.channel === g.channel && (e.topic ?? undefined) === (g.topic ?? undefined),
        );
        deliveredIds.push(...entriesForGroup.map((e) => e.id));
      }
    } catch {
      // Delivery failure — leave entries pending for next flush attempt.
    }
  }

  if (deliveredIds.length > 0) {
    markDelivered(db, deliveredIds);
  }

  return {
    flushed: deliveredIds.length,
    digest: groups,
  };
}

// ============================================================================
// Digest building
// ============================================================================

/**
 * Build a digest string from a list of groups (all for the same channel).
 *
 * Single group, single message → return the message directly (no wrapper).
 */
export function buildDigest(groups: DigestGroup[]): string {
  const totalMessages = groups.reduce((sum, g) => sum + g.messages.length, 0);

  if (totalMessages === 1 && groups.length === 1) {
    return groups[0].messages[0];
  }

  const parts: string[] = [];
  parts.push(`[OpenClaw Digest \u2014 ${totalMessages} update${totalMessages === 1 ? "" : "s"}]`);
  parts.push("");

  for (const group of groups) {
    parts.push(formatDigestGroup(group));
  }

  parts.push("---");
  parts.push("Delivered by OpenClaw notify-queue");

  return parts.join("\n");
}

/** Format a single digest group section. */
export function formatDigestGroup(group: DigestGroup): string {
  const label = group.topic ?? "general";
  const count = group.messages.length;
  const lines: string[] = [];
  lines.push(`--- ${label} (${count}) ---`);
  for (const msg of group.messages) {
    lines.push(`\u2022 ${msg}`);
  }
  lines.push("");
  return lines.join("\n");
}

// ============================================================================
// Grouping helpers
// ============================================================================

function groupByChannelTopic(entries: NotifyQueueEntry[]): DigestGroup[] {
  const map = new Map<string, DigestGroup>();
  for (const entry of entries) {
    const key = `${entry.channel}\0${entry.topic ?? ""}`;
    let group = map.get(key);
    if (!group) {
      group = { channel: entry.channel, topic: entry.topic, messages: [] };
      map.set(key, group);
    }
    group.messages.push(entry.message);
  }
  return Array.from(map.values());
}

function groupByChannel(groups: DigestGroup[]): Map<string, DigestGroup[]> {
  const map = new Map<string, DigestGroup[]>();
  for (const group of groups) {
    let list = map.get(group.channel);
    if (!list) {
      list = [];
      map.set(group.channel, list);
    }
    list.push(group);
  }
  return map;
}
