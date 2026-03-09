/**
 * Cross-post a KB ingest summary to an external channel (e.g., Slack).
 *
 * Only the sanitized title + metadata is posted — never raw page content.
 * Set OPENCLAW_KB_SLACK_WEBHOOK to a Slack incoming webhook URL to enable.
 *
 * Additional channels can be added here (Discord webhook, etc.).
 */
import type { Source } from "./types.ts";

export interface CrosspostPayload {
  source: Source;
  chunkCount: number;
  sanitizationSummary: string;
}

/**
 * Build a clean Slack message block.
 * Strips any metadata, tracking params, or raw content from the summary.
 */
function buildSlackMessage(payload: CrosspostPayload): object {
  const { source, chunkCount, sanitizationSummary } = payload;
  const date = new Date(source.fetched_at).toISOString().split("T")[0];
  const tags = source.tags.length > 0 ? source.tags.map((t) => `\`${t}\``).join(", ") : "_none_";
  const title = source.title ?? "(untitled)";

  return {
    text: `[KB] Ingested: ${title}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*[KB Ingested]* <${source.url}|${title}>`,
        },
      },
      {
        type: "context",
        elements: [
          { type: "mrkdwn", text: `Type: \`${source.source_type}\`` },
          { type: "mrkdwn", text: `Chunks: \`${chunkCount}\`` },
          { type: "mrkdwn", text: `Tags: ${tags}` },
          { type: "mrkdwn", text: `Date: ${date}` },
          { type: "mrkdwn", text: `Sanitization: ${sanitizationSummary}` },
        ],
      },
    ],
  };
}

/**
 * Post a summary to Slack via incoming webhook.
 * No-ops if OPENCLAW_KB_SLACK_WEBHOOK is not set.
 */
export async function crosspostToSlack(payload: CrosspostPayload): Promise<void> {
  const webhookUrl = process.env.OPENCLAW_KB_SLACK_WEBHOOK;
  if (!webhookUrl) {
    return;
  }

  // Validate webhook URL is https (reject accidental local URLs, etc.).
  try {
    const u = new URL(webhookUrl);
    if (u.protocol !== "https:") {
      console.warn("[kb:crosspost] OPENCLAW_KB_SLACK_WEBHOOK must be an https:// URL — skipping.");
      return;
    }
  } catch {
    console.warn("[kb:crosspost] OPENCLAW_KB_SLACK_WEBHOOK is not a valid URL — skipping.");
    return;
  }

  const body = buildSlackMessage(payload);

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.warn(`[kb:crosspost] Slack webhook returned ${res.status} — post may have failed.`);
    } else {
      console.log("[kb:crosspost] Posted summary to Slack.");
    }
  } catch (e) {
    console.warn(`[kb:crosspost] Failed to post to Slack: ${String(e)}`);
  }
}

/**
 * Run all configured cross-post destinations.
 * Currently only Slack; extend here for Discord, email, etc.
 */
export async function crosspost(payload: CrosspostPayload): Promise<void> {
  await crosspostToSlack(payload);
}
