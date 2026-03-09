import type { Command } from "commander";
import {
  getLastRunId,
  openBiDb,
  queryFeedback,
  queryRecommendations,
  resolveBiDbDir,
} from "../../intelligence/bi-store.js";

export function registerCouncilRecsCommand(parent: Command): void {
  parent
    .command("recommendations")
    .alias("recs")
    .description("List recommendations from the most recent (or specified) council run")
    .option("--limit <n>", "Max results", "10")
    .option("--priority <level>", "Filter by priority: high | medium | low")
    .option("--run-id <id>", "Specific run ID (default: latest)")
    .option("--json", "Output as JSON", false)
    .action(async (opts: { limit: string; priority?: string; runId?: string; json: boolean }) => {
      const db = openBiDb(resolveBiDbDir());
      if (!db) {
        console.error("SQLite unavailable.");
        process.exit(1);
      }

      const runId = opts.runId ?? getLastRunId(db);
      if (!runId) {
        console.log("No council runs found. Run `openclaw council run` to start.");
        return;
      }

      const limit = Math.max(1, parseInt(opts.limit, 10) || 10);
      const recs = queryRecommendations(db, {
        runId,
        priority: opts.priority,
        limit,
      });

      if (recs.length === 0) {
        if (opts.json) {
          console.log(JSON.stringify([]));
        } else {
          console.log("No recommendations found for this run.");
        }
        return;
      }

      if (opts.json) {
        const enriched = recs.map((rec) => {
          const feedback = queryFeedback(db, rec.id);
          let domains: string[] = [];
          try {
            domains = JSON.parse(rec.contributing_domains) as string[];
          } catch {
            // ignore
          }
          return { ...rec, contributing_domains: domains, feedback };
        });
        console.log(JSON.stringify(enriched, null, 2));
        return;
      }

      console.log(`Run: ${runId}\n`);
      for (const rec of recs) {
        const fb = queryFeedback(db, rec.id);
        const fbLabel = fb ? ` [${fb.feedback_type.toUpperCase()}]` : "";
        let domains: string[] = [];
        try {
          domains = JSON.parse(rec.contributing_domains) as string[];
        } catch {
          // ignore
        }
        const domainStr = domains.length > 0 ? `  Domains: ${domains.join(", ")}` : "";

        console.log(`${rec.rank}. [${rec.priority.toUpperCase()}] ${rec.title}${fbLabel}`);
        console.log(`   ID: ${rec.id}`);
        console.log(`   ${rec.rationale}`);
        if (domainStr) {
          console.log(`  ${domainStr}`);
        }
        console.log("");
      }
      console.log(`Use \`openclaw council feedback <id> accept|reject|defer\` to record feedback.`);
    });
}
