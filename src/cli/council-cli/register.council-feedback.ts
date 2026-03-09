import type { Command } from "commander";
import {
  openBiDb,
  queryFeedback,
  resolveBiDbDir,
  upsertFeedback,
} from "../../intelligence/bi-store.js";

const VALID_DECISIONS = ["accept", "reject", "defer"] as const;
type Decision = (typeof VALID_DECISIONS)[number];

export function registerCouncilFeedbackCommand(parent: Command): void {
  parent
    .command("feedback <rec-id> <decision>")
    .description("Record feedback on a recommendation (accept | reject | defer)")
    .option("--notes <text>", "Optional notes explaining your decision")
    .action(async (recIdRaw: string, decisionRaw: string, opts: { notes?: string }) => {
      const db = openBiDb(resolveBiDbDir());
      if (!db) {
        console.error("SQLite unavailable.");
        process.exit(1);
      }

      const recId = parseInt(recIdRaw, 10);
      if (isNaN(recId) || recId <= 0) {
        console.error(
          `Invalid recommendation ID: ${recIdRaw}. Use the numeric ID shown in \`openclaw council recommendations\`.`,
        );
        process.exit(1);
      }

      const decision = decisionRaw.toLowerCase().trim();
      if (!VALID_DECISIONS.includes(decision as Decision)) {
        console.error(`Invalid decision: "${decisionRaw}". Must be one of: accept, reject, defer`);
        process.exit(1);
      }

      upsertFeedback(db, {
        recommendationId: recId,
        feedbackType: decision as Decision,
        notes: opts.notes,
      });

      const fb = queryFeedback(db, recId);
      if (!fb) {
        console.error("Failed to record feedback.");
        process.exit(1);
      }

      console.log(`Feedback recorded — rec #${recId}: ${fb.feedback_type.toUpperCase()}`);
      if (fb.notes) {
        console.log(`Notes: ${fb.notes}`);
      }
    });
}
