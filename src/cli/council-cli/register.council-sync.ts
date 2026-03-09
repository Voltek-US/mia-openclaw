import { execSync } from "node:child_process";
import path from "node:path";
import type { Command } from "commander";

const ALL_SOURCES = ["chat", "crm", "projects", "social", "financial"] as const;
type SourceName = (typeof ALL_SOURCES)[number];

const SYNC_SCRIPTS: Record<SourceName, string> = {
  chat: "scripts/council-sync-chat.ts",
  crm: "scripts/council-sync-crm.ts",
  projects: "scripts/council-sync-projects.ts",
  social: "scripts/council-sync-social.ts",
  financial: "scripts/council-sync-financial.ts",
};

export function registerCouncilSyncCommand(parent: Command): void {
  parent
    .command("sync")
    .description("Trigger a data sync for one or all sources")
    .option("--source <name>", `Source to sync: ${ALL_SOURCES.join(" | ")} (default: all)`)
    .option("--dry-run", "Print what would be synced without writing to DB", false)
    .option("--verbose", "Verbose output", false)
    .action(async (opts: { source?: string; dryRun: boolean; verbose: boolean }) => {
      const sources: SourceName[] = opts.source
        ? [opts.source.toLowerCase().trim() as SourceName]
        : [...ALL_SOURCES];

      for (const src of sources) {
        if (!ALL_SOURCES.includes(src)) {
          console.error(`Unknown source: "${src}". Valid values: ${ALL_SOURCES.join(", ")}`);
          process.exit(1);
        }
      }

      // Resolve repo root (scripts live at repo root / scripts/)
      const repoRoot = path.resolve(import.meta.dirname, "../../../");

      for (const src of sources) {
        const scriptPath = path.join(repoRoot, SYNC_SCRIPTS[src]);
        const args = [opts.dryRun ? "--dry-run" : "", opts.verbose ? "--verbose" : ""]
          .filter(Boolean)
          .join(" ");

        console.log(`Syncing ${src}...`);
        try {
          execSync(`bun ${JSON.stringify(scriptPath)} ${args}`, {
            stdio: "inherit",
            cwd: repoRoot,
          });
        } catch (err) {
          console.error(`Sync failed for ${src}:`, err instanceof Error ? err.message : err);
          // Continue with remaining sources even if one fails.
        }
      }
    });
}
