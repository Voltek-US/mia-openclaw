import type { Command } from "commander";
import {
  listContacts,
  listPendingFollowUps,
  listAllPendingTasks,
  openCrmDb,
} from "../../intelligence/crm/crm-store.js";

export function registerCrmStatsCommand(parent: Command): void {
  parent
    .command("stats")
    .description("Show CRM statistics")
    .option("--json", "Output as JSON", false)
    .action(async (opts: { json: boolean }) => {
      const db = openCrmDb();
      if (!db) {
        console.error("SQLite unavailable.");
        process.exit(1);
      }

      const contacts = listContacts(db, { limit: 100_000 });
      const byType: Record<string, number> = {};
      const byPriority: Record<string, number> = {};
      for (const c of contacts) {
        byType[c.relationship_type] = (byType[c.relationship_type] ?? 0) + 1;
        byPriority[c.priority] = (byPriority[c.priority] ?? 0) + 1;
      }

      const linked = listPendingFollowUps(db);
      const standalone = listAllPendingTasks(db);
      const allTasks = [...linked, ...standalone].filter(
        (t, i, arr) => arr.findIndex((r) => r.id === t.id) === i,
      );
      const overdue = allTasks.filter((t) => t.due_at < Date.now()).length;

      const stats = {
        totalContacts: contacts.length,
        byType,
        byPriority,
        pendingTasks: allTasks.length,
        overdueTasks: overdue,
      };

      if (opts.json) {
        console.log(JSON.stringify(stats, null, 2));
        return;
      }

      console.log(`\nCRM Statistics`);
      console.log(`──────────────`);
      console.log(`Total contacts:   ${contacts.length}`);
      console.log(`By type:`);
      for (const [type, count] of Object.entries(byType)) {
        console.log(`  ${type.padEnd(15)} ${count}`);
      }
      console.log(`By priority:`);
      for (const [p, count] of Object.entries(byPriority)) {
        console.log(`  ${p.padEnd(15)} ${count}`);
      }
      console.log(`Pending tasks:    ${allTasks.length} (${overdue} overdue)`);
    });
}
