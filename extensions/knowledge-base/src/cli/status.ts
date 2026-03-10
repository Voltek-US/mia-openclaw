import fs from "node:fs/promises";
import type { Command } from "commander";
import type { OpenClawConfig } from "openclaw/plugin-sdk/knowledge-base";
import { openKbDb, resolveKbDbPath, runPreflightChecks } from "../db.js";
import { createKbEmbedder } from "../embed.js";

export function registerStatusCommand(kb: Command, config: OpenClawConfig): void {
  kb.command("status")
    .description("Show knowledge base status and preflight health check")
    .action(async () => {
      const dbPath = resolveKbDbPath();

      console.log(`KB path: ${dbPath}\n`);

      const preflight = await runPreflightChecks(dbPath);
      if (preflight.issues.length > 0) {
        for (const issue of preflight.issues) {
          const isInfo = issue.startsWith("Removed");
          console.log(`${isInfo ? "ℹ" : "✗"} ${issue}`);
        }
      }

      if (!preflight.ok) {
        console.log("\nPreflight failed. Fix the issues above before using the KB.");
        process.exitCode = 1;
        return;
      }

      console.log("✓ Preflight OK");
      console.log(
        `✓ sqlite-vec: ${preflight.vecAvailable ? "available" : "not available (FTS-only mode)"}`,
      );

      // DB stats.
      try {
        const db = await openKbDb(dbPath);

        const sourceCount = (
          db.db.prepare("SELECT COUNT(*) AS n FROM kb_sources WHERE status = 'ok'").get() as {
            n: number;
          }
        ).n;

        const chunkCount = (
          db.db.prepare("SELECT COUNT(*) AS n FROM kb_chunks").get() as { n: number }
        ).n;

        const embeddingDim = db.db
          .prepare("SELECT value FROM kb_meta WHERE key = 'embedding_dim'")
          .get() as { value: string } | undefined;

        const typeCounts = db.db
          .prepare(
            "SELECT source_type, COUNT(*) AS n FROM kb_sources WHERE status = 'ok' GROUP BY source_type",
          )
          .all() as { source_type: string; n: number }[];

        let dbSizeKb = 0;
        try {
          const stat = await fs.stat(dbPath);
          dbSizeKb = Math.round(stat.size / 1024);
        } catch {
          // DB may not exist yet.
        }

        console.log(`\nDB size:    ${dbSizeKb} KB`);
        console.log(`Sources:    ${sourceCount}`);
        console.log(`Chunks:     ${chunkCount}`);
        console.log(`Embed dim:  ${embeddingDim?.value ?? "not set (no data ingested yet)"}`);

        if (typeCounts.length > 0) {
          console.log("\nBy type:");
          for (const row of typeCounts) {
            console.log(`  ${row.source_type.padEnd(10)} ${row.n}`);
          }
        }

        // Probe embedding provider.
        const embedder = await createKbEmbedder({ config });
        const providerName = embedder.provider?.id ?? "none (FTS-only)";
        const providerModel = embedder.provider?.model ?? "";
        console.log(`\nEmbedder:   ${providerName}${providerModel ? ` (${providerModel})` : ""}`);
      } catch (err) {
        console.error(`\nCould not open DB: ${String(err)}`);
        process.exitCode = 1;
      }
    });
}
