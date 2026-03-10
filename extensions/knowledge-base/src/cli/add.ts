import fs from "node:fs/promises";
import type { Command } from "commander";
import type { OpenClawConfig } from "openclaw/plugin-sdk/knowledge-base";
import { openKbDb, resolveKbDbPath, runPreflightChecks } from "../db.js";
import { createKbEmbedder } from "../embed.js";
import { addManual } from "../ingest.js";

const VALID_TYPES = ["howto", "prompt", "issue"] as const;
type ManualType = (typeof VALID_TYPES)[number];

export function registerAddCommand(kb: Command, config: OpenClawConfig): void {
  kb.command("add")
    .description("Add a how-to, prompt, or known issue to the knowledge base")
    .requiredOption("--type <type>", `Entry type: ${VALID_TYPES.join(", ")}`)
    .requiredOption("--title <title>", "Short descriptive title")
    .option("--text <text>", "Entry text (inline)")
    .option("--file <path>", "Read entry text from a file")
    .option("--tags <tags>", "Comma-separated tags", "")
    .option("--dry-run", "Parse but skip writing to DB")
    .action(async (opts) => {
      const type = opts.type as string;
      if (!VALID_TYPES.includes(type as ManualType)) {
        console.error(`Invalid type "${type}". Must be one of: ${VALID_TYPES.join(", ")}`);
        process.exitCode = 1;
        return;
      }

      let text: string;
      if (opts.text) {
        text = opts.text as string;
      } else if (opts.file) {
        try {
          text = await fs.readFile(opts.file as string, "utf8");
        } catch (err) {
          console.error(`Cannot read file: ${String(err)}`);
          process.exitCode = 1;
          return;
        }
      } else {
        console.error("Provide --text <text> or --file <path>.");
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

      try {
        const result = await addManual(db, embedder, {
          type: type as ManualType,
          title: opts.title as string,
          text,
          tags,
          dryRun,
        });

        if (result.dryRun) {
          console.log(
            `Dry run: "${result.title}" [${result.sourceType}] → ${result.chunksWritten} chunk(s) would be written`,
          );
        } else {
          console.log(
            `Added: "${result.title}" [${result.sourceType}] → ${result.chunksWritten} chunk(s) (id: ${result.sourceId})`,
          );
        }
      } catch (err) {
        console.error(`Error: ${String(err)}`);
        process.exitCode = 1;
      }
    });
}
