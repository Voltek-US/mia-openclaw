import fs from "node:fs/promises";
import type { Command } from "commander";
import type { OpenClawConfig } from "openclaw/plugin-sdk/knowledge-base";
import { openKbDb, resolveKbDbPath, runPreflightChecks } from "../db.js";
import { createKbEmbedder } from "../embed.js";
import { ingestBatch, ingestUrl } from "../ingest.js";

export function registerIngestCommand(kb: Command, config: OpenClawConfig): void {
  kb.command("ingest [url]")
    .description("Ingest a URL or a file of URLs into the knowledge base")
    .option("--file <path>", "Path to a newline-separated file of URLs")
    .option("--tags <tags>", "Comma-separated tags to attach", "")
    .option("--dry-run", "Fetch and parse but skip writing to DB")
    .option("--cross-post <channel>", "Post a summary to this channel after ingesting")
    .option("--concurrency <n>", "Max concurrent fetches (for --file mode)", "3")
    .action(async (url: string | undefined, opts) => {
      const dbPath = resolveKbDbPath();
      const preflight = await runPreflightChecks(dbPath);

      if (!preflight.ok) {
        for (const issue of preflight.issues) {
          console.error(`KB preflight: ${issue}`);
        }
        process.exitCode = 1;
        return;
      }

      const tags = opts.tags
        ? (opts.tags as string)
            .split(",")
            .map((t: string) => t.trim())
            .filter(Boolean)
        : [];
      const dryRun = Boolean(opts.dryRun);
      const crossPost = opts.crossPost as string | undefined;
      const concurrency = parseInt(opts.concurrency as string, 10) || 3;

      const db = await openKbDb(dbPath);
      const embedder = await createKbEmbedder({ config });

      if (opts.file) {
        // Bulk ingest from file.
        const raw = await fs.readFile(opts.file as string, "utf8");
        const urls = raw
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length > 0 && !l.startsWith("#"));

        if (urls.length === 0) {
          console.error("No URLs found in file.");
          process.exitCode = 1;
          return;
        }

        console.log(`Ingesting ${urls.length} URL(s)...`);
        let done = 0;

        const results = await ingestBatch(
          urls,
          db,
          embedder,
          { tags, dryRun, crossPost, concurrency },
          (completed, total, currentUrl) => {
            done = completed;
            process.stdout.write(`  [${completed}/${total}] ${currentUrl}\n`);
          },
        );

        const written = results.filter((r) => !r.skipped && !r.dryRun);
        const skipped = results.filter((r) => r.skipped);
        console.log(
          `Done: ${written.length} ingested, ${skipped.length} skipped (already in KB), ${urls.length - done} errors.`,
        );
      } else if (url) {
        // Single URL ingest.
        try {
          const result = await ingestUrl(url, db, embedder, { tags, dryRun, crossPost });
          if (result.skipped) {
            console.log(`Skipped (already in KB): ${url}`);
          } else if (result.dryRun) {
            console.log(
              `Dry run: "${result.title}" → ${result.chunksWritten} chunk(s) would be written`,
            );
          } else {
            console.log(
              `Ingested: "${result.title}" [${result.sourceType}] → ${result.chunksWritten} chunk(s) (id: ${result.sourceId})`,
            );
          }
        } catch (err) {
          console.error(`Error: ${String(err)}`);
          process.exitCode = 1;
        }
      } else {
        console.error("Provide a URL or --file <path>.");
        process.exitCode = 1;
      }
    });
}
