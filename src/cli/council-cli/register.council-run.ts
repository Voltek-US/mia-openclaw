import type { Command } from "commander";
import { openBiDb, resolveBiDbDir } from "../../intelligence/bi-store.js";
import { runCouncil } from "../../intelligence/council.js";
import { formatDigest, sendDigest, sendErrorAlert } from "../../intelligence/delivery.js";

export function registerCouncilRunCommand(parent: Command): void {
  parent
    .command("run")
    .description("Run the BI council now — expert analysis + synthesis + delivery")
    .option("--dry-run", "Skip DB writes and channel delivery; print digest to stdout", false)
    .option("--verbose", "Verbose logging", false)
    .option("--lookback <days>", "Days of signal history to include", "3")
    .action(async (opts: { dryRun: boolean; verbose: boolean; lookback: string }) => {
      const channel = process.env.COUNCIL_CHANNEL?.trim();
      const lookbackDays = Math.max(1, parseInt(opts.lookback, 10) || 3);

      const db = openBiDb(resolveBiDbDir());
      if (!db) {
        console.error("SQLite unavailable — cannot run council.");
        process.exit(1);
      }

      let result;
      try {
        result = await runCouncil(db, {
          dryRun: opts.dryRun,
          verbose: opts.verbose,
          lookbackDays,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("Council run failed:", msg);
        if (channel && !opts.dryRun) {
          sendErrorAlert(channel, msg);
        }
        process.exit(1);
      }

      const { runId, expertAnalyses, recommendations, runDurationMs, skippedExperts } = result;
      console.log(
        `Run ${runId} complete — ${expertAnalyses.length} experts, ` +
          `${recommendations.length} recommendations, ${(runDurationMs / 1000).toFixed(1)}s`,
      );
      if (skippedExperts.length > 0) {
        console.warn(`Skipped experts: ${skippedExperts.join(", ")}`);
      }

      const digest = formatDigest(runId, db);

      if (opts.dryRun) {
        console.log("\n--- Digest preview ---\n" + digest);
        return;
      }

      if (!channel) {
        console.warn("COUNCIL_CHANNEL not set — digest not delivered.");
        return;
      }

      sendDigest(digest, channel);
      console.log(`Digest delivered to ${channel}`);
    });
}
