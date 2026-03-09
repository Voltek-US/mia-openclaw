import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { registerCrmAuthCommands } from "./register.crm-auth.js";
import { registerCrmContactCommands } from "./register.crm-contact.js";
import { registerCrmNudgesCommand } from "./register.crm-nudges.js";
import { registerCrmStatsCommand } from "./register.crm-stats.js";
import { registerCrmTaskCommands } from "./register.crm-task.js";

export function registerCrmCli(program: Command): void {
  const crm = program
    .command("crm")
    .description("Personal CRM — contacts, tasks, follow-ups, and relationship intelligence");

  registerCrmAuthCommands(crm);
  registerCrmContactCommands(crm);
  registerCrmTaskCommands(crm);
  registerCrmNudgesCommand(crm);
  registerCrmStatsCommand(crm);

  crm
    .command("discover")
    .description("Interactive contact discovery — scan email/calendar and approve new contacts")
    .option("--dry-run", "Show candidates without writing to DB")
    .option("--verbose", "Print progress")
    .option("--since <ISO>", "Override lookback window (default: 7 days)")
    .option("--provider <p>", "Provider: gmail | ms365 | auto (default: auto)")
    .action((opts: { dryRun?: boolean; verbose?: boolean; since?: string; provider?: string }) => {
      const scriptPath = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../../scripts/crm-discover.ts",
      );
      const args: string[] = [];
      if (opts.dryRun) {
        args.push("--dry-run");
      }
      if (opts.verbose) {
        args.push("--verbose");
      }
      if (opts.since) {
        args.push("--since", opts.since);
      }
      if (opts.provider) {
        args.push("--provider", opts.provider);
      }

      execSync(`bun ${JSON.stringify(scriptPath)} ${args.join(" ")}`, {
        stdio: "inherit",
      });
    });
}
