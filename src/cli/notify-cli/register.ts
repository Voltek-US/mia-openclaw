import type { Command } from "commander";
import { classifyMessage } from "../../infra/notify-queue/classifier.js";
import { loadNotifyQueueConfig } from "../../infra/notify-queue/config.js";
import { flushTier } from "../../infra/notify-queue/flush.js";
import {
  countPendingByTier,
  enqueueNotification,
  listPending,
  openNotifyQueueDb,
  pruneDelivered,
  type NotifyTier,
} from "../../infra/notify-queue/store.js";

function getDb() {
  return openNotifyQueueDb();
}

function isTier(v: unknown): v is NotifyTier {
  return v === "critical" || v === "high" || v === "medium";
}

function requireTier(v: string): NotifyTier {
  if (!isTier(v)) {
    throw new Error(`Invalid tier "${v}". Must be one of: critical, high, medium`);
  }
  return v;
}

/**
 * Build a delivery function that prints to stdout (default) or uses a
 * real channel adapter if the channel is known.
 *
 * For now we emit to stdout; callers (cron, shell) can pipe output.
 * Production callers that want real channel delivery should call
 * notifyViaQueue() from deliver.ts with bypass: true on flush.
 */
async function defaultDeliverFn(channel: string, text: string): Promise<void> {
  // Dynamic import keeps this module free of heavy channel dependencies.
  try {
    const { notifyViaQueue } = await import("../../infra/outbound/deliver.js");
    await notifyViaQueue({ message: text, channel, bypass: true });
  } catch {
    // Fallback: print to stdout so the message is not lost.
    process.stdout.write(`[${channel}] ${text}\n`);
  }
}

export function registerNotifyCli(program: Command) {
  const notify = program.command("notify").description("Manage the notification priority queue");

  // ─── enqueue ────────────────────────────────────────────────────────────────
  notify
    .command("enqueue")
    .description("Add a notification to the priority queue")
    .argument("<message>", "Message text to enqueue")
    .requiredOption("--channel <channel>", "Target channel (e.g. telegram, slack)")
    .option("--tier <tier>", "Priority tier: critical|high|medium (auto-detected if omitted)")
    .option("--topic <topic>", "Optional topic/group label for digest grouping")
    .option("--type <type>", "Message type for rule-based classification")
    .option("--bypass", "Send immediately, bypassing the queue", false)
    .action(
      async (
        message: string,
        opts: {
          channel: string;
          tier?: string;
          topic?: string;
          type?: string;
          bypass: boolean;
        },
      ) => {
        try {
          if (opts.bypass) {
            // Immediate delivery — skip queue.
            const { notifyViaQueue } = await import("../../infra/outbound/deliver.js");
            await notifyViaQueue({
              message,
              channel: opts.channel,
              topic: opts.topic,
              messageType: opts.type,
              bypass: true,
            });
            process.stdout.write("Delivered immediately (bypass mode)\n");
            return;
          }

          const config = loadNotifyQueueConfig();
          let tier: NotifyTier;

          if (opts.tier) {
            tier = requireTier(opts.tier);
          } else {
            // Auto-classify.
            tier = await classifyMessage(message, opts.type, config);
          }

          const db = getDb();
          const id = enqueueNotification(db, {
            tier,
            channel: opts.channel,
            message,
            topic: opts.topic,
            messageType: opts.type,
          });

          // Critical messages flush immediately.
          if (tier === "critical") {
            const result = await flushTier(db, "critical", defaultDeliverFn);
            process.stdout.write(
              `Enqueued as critical (id=${id}) and flushed ${result.flushed} message(s)\n`,
            );
          } else {
            process.stdout.write(`Enqueued [${tier}] id=${id}\n`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`notify enqueue: ${msg}\n`);
          process.exit(1);
        }
      },
    );

  // ─── flush ──────────────────────────────────────────────────────────────────
  notify
    .command("flush")
    .description("Flush and deliver all pending messages for a tier")
    .requiredOption("--tier <tier>", "Tier to flush: critical|high|medium")
    .option("--prune", "Also prune old delivered entries after flush", false)
    .action(async (opts: { tier: string; prune: boolean }) => {
      try {
        const tier = requireTier(opts.tier);
        const db = getDb();
        const result = await flushTier(db, tier, defaultDeliverFn);

        if (opts.prune) {
          const removed = pruneDelivered(db);
          process.stdout.write(
            `Flushed ${result.flushed} message(s); pruned ${removed} old delivered entries\n`,
          );
        } else {
          process.stdout.write(`Flushed ${result.flushed} message(s) for tier=${tier}\n`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`notify flush: ${msg}\n`);
        process.exit(1);
      }
    });

  // ─── list ───────────────────────────────────────────────────────────────────
  notify
    .command("list")
    .description("List pending notifications")
    .option("--tier <tier>", "Filter by tier: critical|high|medium")
    .option("--json", "Output as JSON", false)
    .action((opts: { tier?: string; json: boolean }) => {
      try {
        const tier = opts.tier ? requireTier(opts.tier) : undefined;
        const db = getDb();
        const entries = listPending(db, tier);

        if (opts.json) {
          process.stdout.write(JSON.stringify(entries, null, 2) + "\n");
          return;
        }

        if (entries.length === 0) {
          process.stdout.write("No pending notifications\n");
          return;
        }

        for (const e of entries) {
          const ts = new Date(e.enqueuedAt).toISOString();
          const topicStr = e.topic ? ` [${e.topic}]` : "";
          process.stdout.write(
            `${e.id.slice(0, 8)}  ${e.tier.padEnd(8)}  ${e.channel}${topicStr}  ${ts}  ${e.message}\n`,
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`notify list: ${msg}\n`);
        process.exit(1);
      }
    });

  // ─── status ─────────────────────────────────────────────────────────────────
  notify
    .command("status")
    .description("Show pending notification counts by tier")
    .option("--json", "Output as JSON", false)
    .action((opts: { json: boolean }) => {
      try {
        const db = getDb();
        const counts = countPendingByTier(db);

        if (opts.json) {
          process.stdout.write(JSON.stringify(counts, null, 2) + "\n");
          return;
        }

        process.stdout.write("Pending notifications:\n");
        process.stdout.write(`  critical : ${counts.critical}\n`);
        process.stdout.write(`  high     : ${counts.high}\n`);
        process.stdout.write(`  medium   : ${counts.medium}\n`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`notify status: ${msg}\n`);
        process.exit(1);
      }
    });
}
