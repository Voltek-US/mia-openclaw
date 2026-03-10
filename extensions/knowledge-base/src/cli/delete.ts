import readline from "node:readline/promises";
import type { Command } from "commander";
import { openKbDb, resolveKbDbPath, runPreflightChecks } from "../db.js";

export function registerDeleteCommand(kb: Command): void {
  kb.command("delete <source-id>")
    .description("Delete a source and all its chunks from the knowledge base")
    .option("--yes", "Skip confirmation prompt")
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
        .prepare("SELECT id, title, source_type FROM kb_sources WHERE id = ?")
        .get(sourceId) as { id: string; title: string; source_type: string } | undefined;

      if (!source) {
        console.error(`Source not found: ${sourceId}`);
        process.exitCode = 1;
        return;
      }

      if (!opts.yes) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        try {
          const answer = await rl.question(
            `Delete "${source.title}" [${source.source_type}]? (y/N) `,
          );
          if (answer.trim().toLowerCase() !== "y") {
            console.log("Cancelled.");
            return;
          }
        } finally {
          rl.close();
        }
      }

      // Delete in order: FTS, vec, chunks, source (all in one transaction).
      // Virtual tables don't cascade automatically.
      db.db.prepare("BEGIN").run();
      try {
        db.db.prepare("DELETE FROM kb_chunks_fts WHERE source_id = ?").run(sourceId);

        // vec0 table may not exist on FTS-only installs.
        try {
          db.db
            .prepare(
              "DELETE FROM kb_chunks_vec WHERE id IN (SELECT id FROM kb_chunks WHERE source_id = ?)",
            )
            .run(sourceId);
        } catch {
          // vec0 table not available — skip.
        }

        db.db.prepare("DELETE FROM kb_chunks WHERE source_id = ?").run(sourceId);
        db.db.prepare("DELETE FROM kb_sources WHERE id = ?").run(sourceId);
        db.db.prepare("COMMIT").run();
      } catch (err) {
        db.db.prepare("ROLLBACK").run();
        throw err;
      }

      console.log(`Deleted: "${source.title}" [${source.source_type}] (${sourceId})`);
    });
}
