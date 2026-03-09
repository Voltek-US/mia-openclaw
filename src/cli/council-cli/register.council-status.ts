import type { Command } from "commander";
import {
  getLastRunId,
  openBiDb,
  queryExpertAnalyses,
  queryRecommendations,
  resolveBiDbDir,
} from "../../intelligence/bi-store.js";

export function registerCouncilStatusCommand(parent: Command): void {
  parent
    .command("status")
    .description(
      "Show the most recent council run — when it ran, expert count, recommendation count",
    )
    .option("--json", "Output as JSON", false)
    .action(async (opts: { json: boolean }) => {
      const db = openBiDb(resolveBiDbDir());
      if (!db) {
        console.error("SQLite unavailable.");
        process.exit(1);
      }

      const runId = getLastRunId(db);
      if (!runId) {
        if (opts.json) {
          console.log(JSON.stringify({ runId: null, message: "No council runs found." }));
        } else {
          console.log("No council runs found. Run `openclaw council run` to start.");
        }
        return;
      }

      const analyses = queryExpertAnalyses(db, { runId });
      const recs = queryRecommendations(db, { runId });
      const createdAt = recs[0]?.created_at ?? analyses[0]?.created_at ?? 0;
      const date = createdAt ? new Date(createdAt).toISOString() : "unknown";

      const highCount = recs.filter((r) => r.priority === "high").length;
      const medCount = recs.filter((r) => r.priority === "medium").length;
      const lowCount = recs.filter((r) => r.priority === "low").length;

      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              runId,
              date,
              expertCount: analyses.length,
              recommendationCount: recs.length,
              highCount,
              medCount,
              lowCount,
            },
            null,
            2,
          ),
        );
        return;
      }

      console.log(`Last run:       ${runId}`);
      console.log(`Date:           ${date}`);
      console.log(`Experts:        ${analyses.length}`);
      console.log(
        `Recommendations: ${recs.length} (${highCount} high, ${medCount} medium, ${lowCount} low)`,
      );
      console.log("");
      console.log("Run `openclaw council recommendations` to browse recommendations.");
    });
}
