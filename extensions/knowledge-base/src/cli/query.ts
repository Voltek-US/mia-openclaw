import type { Command } from "commander";
import type { OpenClawConfig } from "openclaw/plugin-sdk/knowledge-base";
import { openKbDb, resolveKbDbPath, runPreflightChecks } from "../db.js";
import { createKbEmbedder } from "../embed.js";
import type { SourceType } from "../fetch.js";
import { queryKb, type QueryResult } from "../query.js";

export function registerQueryCommand(kb: Command, config: OpenClawConfig): void {
  kb.command("query <text>")
    .description("Search the knowledge base with semantic or FTS search")
    .option("--tag <tag>", "Filter by tag")
    .option(
      "--type <type>",
      "Filter by source type (article, tweet, youtube, pdf, howto, prompt, issue)",
    )
    .option("--since <date>", "Filter to entries ingested after this date (YYYY-MM-DD)")
    .option("--limit <n>", "Maximum results to return", "10")
    .option("--threshold <f>", "Minimum similarity threshold (0–1)", "0.7")
    .option("--json", "Output results as JSON")
    .action(async (text: string, opts) => {
      const dbPath = resolveKbDbPath();
      const preflight = await runPreflightChecks(dbPath);
      if (!preflight.ok) {
        for (const issue of preflight.issues) {
          console.error(`KB preflight: ${issue}`);
        }
        process.exitCode = 1;
        return;
      }

      const db = await openKbDb(dbPath);
      const embedder = await createKbEmbedder({ config });

      const limit = parseInt(opts.limit as string, 10) || 10;
      const threshold = parseFloat(opts.threshold as string) || 0.7;
      const since = opts.since ? new Date(opts.since as string) : undefined;
      const sourceType = opts.type as SourceType | undefined;

      try {
        const results = await queryKb(db, embedder, text, {
          tag: opts.tag as string | undefined,
          sourceType,
          since,
          limit,
          threshold,
        });

        if (opts.json) {
          console.log(JSON.stringify(results, null, 2));
          return;
        }

        if (results.length === 0) {
          console.log("No results found.");
          return;
        }

        console.log(`\nFound ${results.length} result(s) for "${text}":\n`);
        for (const r of results) {
          printResult(r);
        }
      } catch (err) {
        console.error(`Error: ${String(err)}`);
        process.exitCode = 1;
      }
    });
}

function printResult(r: QueryResult): void {
  const score = (r.score * 100).toFixed(0);
  const excerpt = r.text.slice(0, 120).replace(/\n/g, " ");
  const tags = r.tags.length > 0 ? ` [${r.tags.join(", ")}]` : "";
  const mode = r.matchMode === "fts" ? "FTS" : `${score}%`;

  console.log(`  [${mode}] ${r.title}${tags}`);
  console.log(`  ${r.url}`);
  console.log(`  ${excerpt}${r.text.length > 120 ? "..." : ""}`);
  console.log();
}
