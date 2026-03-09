import type { Command } from "commander";
import { generateNudges } from "../../intelligence/crm/crm-nudge.js";
import { openCrmDb } from "../../intelligence/crm/crm-store.js";

export function registerCrmNudgesCommand(parent: Command): void {
  parent
    .command("nudges")
    .description("Show contacts needing attention and overdue tasks")
    .option("--max <n>", "Max relationship nudges to show (default: 20)")
    .action(async (opts: { max?: string }) => {
      const db = openCrmDb();
      if (!db) {
        console.error("SQLite unavailable.");
        process.exit(1);
      }

      const maxNudges = opts.max ? parseInt(opts.max, 10) : 20;
      const { relationshipNudges, overdueTasks } = generateNudges(db, { maxNudges });

      if (relationshipNudges.length === 0 && overdueTasks.length === 0) {
        console.log("All clear — no nudges and no overdue tasks.");
        return;
      }

      if (relationshipNudges.length > 0) {
        console.log(`\nRelationship nudges (${relationshipNudges.length}):`);
        for (const n of relationshipNudges) {
          const days = n.daysSinceLast !== null ? `${n.daysSinceLast}d ago` : "never";
          console.log(
            `  ${n.name.padEnd(25)} ${n.email.padEnd(35)} [${n.relationshipType}] last: ${days} — ${n.reason}`,
          );
        }
      }

      if (overdueTasks.length > 0) {
        console.log(`\nOverdue tasks (${overdueTasks.length}):`);
        for (const t of overdueTasks) {
          const due = new Date(t.dueAt).toLocaleDateString();
          const who = t.contactName ? ` [${t.contactName}]` : "";
          console.log(`  #${t.id}: ${t.title}${who} (was due ${due})`);
        }
      }
    });
}
