import type { Command } from "commander";
import { openKbDb, resolveKbDbPath, runPreflightChecks } from "../db.js";

type SourceRow = {
  id: string;
  url: string;
  title: string;
  source_type: string;
  tags: string;
  ingested_at: number;
  chunk_count: number;
};

export function registerListCommand(kb: Command): void {
  kb.command("list")
    .description("List knowledge base sources")
    .option("--tag <tag>", "Filter by tag")
    .option("--type <type>", "Filter by source type")
    .option("--since <date>", "Filter to entries ingested after this date (YYYY-MM-DD)")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
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

      let sql = `
        SELECT s.id, s.url, s.title, s.source_type, s.tags, s.ingested_at,
               COUNT(c.id) AS chunk_count
        FROM kb_sources s
        LEFT JOIN kb_chunks c ON c.source_id = s.id
        WHERE s.status = 'ok'
      `;
      const params: (string | number)[] = [];

      if (opts.type) {
        sql += " AND s.source_type = ?";
        params.push(opts.type as string);
      }

      if (opts.since) {
        const sinceMs = new Date(opts.since as string).getTime();
        sql += " AND s.ingested_at >= ?";
        params.push(sinceMs);
      }

      sql += " GROUP BY s.id ORDER BY s.ingested_at DESC";

      let rows = db.db.prepare(sql).all(...params) as SourceRow[];

      // Apply tag filter in memory (JSON_EACH not available in all SQLite versions).
      if (opts.tag) {
        const tag = opts.tag as string;
        rows = rows.filter((r) => {
          const tags: string[] = JSON.parse(r.tags || "[]") as string[];
          return tags.includes(tag);
        });
      }

      if (opts.json) {
        const output = rows.map((r) => ({
          id: r.id,
          url: r.url,
          title: r.title,
          sourceType: r.source_type,
          tags: JSON.parse(r.tags || "[]") as string[],
          ingestedAt: new Date(r.ingested_at).toISOString(),
          chunkCount: r.chunk_count,
        }));
        console.log(JSON.stringify(output, null, 2));
        return;
      }

      if (rows.length === 0) {
        console.log("No entries found.");
        return;
      }

      console.log(`\n${rows.length} KB source(s):\n`);
      for (const r of rows) {
        const tags: string[] = JSON.parse(r.tags || "[]") as string[];
        const tagStr = tags.length > 0 ? ` [${tags.join(", ")}]` : "";
        const date = new Date(r.ingested_at).toISOString().split("T")[0];
        console.log(
          `  ${r.id.slice(0, 8)}  ${date}  ${r.source_type.padEnd(8)}  ${r.title}${tagStr}`,
        );
        if (!r.url.startsWith("local:")) {
          console.log(`           ${r.url}`);
        }
        console.log(`           ${r.chunk_count} chunk(s)`);
      }
      console.log();
    });
}
