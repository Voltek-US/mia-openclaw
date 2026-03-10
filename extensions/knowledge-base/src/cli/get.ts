import type { Command } from "commander";
import { openKbDb, resolveKbDbPath, runPreflightChecks } from "../db.js";

export function registerGetCommand(kb: Command): void {
  kb.command("get <source-id>")
    .description("Print the full text of a KB source (pipe-friendly for prompts)")
    .option("--raw", "Print raw text only, no decorations (ideal for shell substitution)")
    .action(async (sourceId: string, opts) => {
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

      const source = db.db
        .prepare("SELECT id, url, title, source_type, tags FROM kb_sources WHERE id = ?")
        .get(sourceId) as
        | { id: string; url: string; title: string; source_type: string; tags: string }
        | undefined;

      if (!source) {
        console.error(`Source not found: ${sourceId}`);
        process.exitCode = 1;
        return;
      }

      const chunks = db.db
        .prepare("SELECT text FROM kb_chunks WHERE source_id = ? ORDER BY chunk_idx ASC")
        .all(sourceId) as { text: string }[];

      const fullText = chunks.map((c) => c.text).join("\n\n");

      if (opts.raw) {
        // Print raw text with no decoration — safe for `$(openclaw kb get <id>)`.
        process.stdout.write(fullText);
        if (!fullText.endsWith("\n")) {
          process.stdout.write("\n");
        }
        return;
      }

      const tags: string[] = JSON.parse(source.tags || "[]") as string[];
      console.log(`Title:  ${source.title}`);
      console.log(`Type:   ${source.source_type}`);
      console.log(`URL:    ${source.url}`);
      if (tags.length > 0) {
        console.log(`Tags:   ${tags.join(", ")}`);
      }
      console.log(`\n---\n\n${fullText}`);
    });
}
