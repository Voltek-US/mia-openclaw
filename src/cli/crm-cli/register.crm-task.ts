import type { Command } from "commander";
import {
  cancelFollowUp,
  listAllPendingTasks,
  listPendingFollowUps,
  markFollowUpDone,
  openCrmDb,
  snoozeFollowUp,
  upsertFollowUp,
  type TaskType,
} from "../../intelligence/crm/crm-store.js";

export function registerCrmTaskCommands(parent: Command): void {
  const taskCmd = parent.command("task").description("Manage personal tasks and follow-ups");

  // ---- list ----
  taskCmd
    .command("list")
    .description("List all pending tasks and follow-ups")
    .option("--type <type>", "Filter by task type (follow_up/task/reminder/birthday/event)")
    .option("--overdue", "Show only overdue tasks", false)
    .action(async (opts: { type?: string; overdue: boolean }) => {
      const db = openCrmDb();
      if (!db) {
        console.error("SQLite unavailable.");
        process.exit(1);
      }

      const cutoff = opts.overdue ? Date.now() : undefined;
      const linked = listPendingFollowUps(db, {
        type: opts.type as TaskType | undefined,
        cutoff,
      });
      const standalone = listAllPendingTasks(db);

      const all = [...linked, ...standalone]
        // Deduplicate (standalone are a subset of linked when contact_id IS NULL)
        .filter((row, idx, arr) => arr.findIndex((r) => r.id === row.id) === idx)
        .filter((row) => !opts.type || row.task_type === opts.type)
        .toSorted((a, b) => a.due_at - b.due_at);

      if (all.length === 0) {
        console.log("No pending tasks.");
        return;
      }

      for (const t of all) {
        const due = new Date(t.due_at).toLocaleDateString();
        const overdue = t.due_at < Date.now() ? " [OVERDUE]" : "";
        console.log(`#${t.id}: ${t.title}  (due ${due} | ${t.task_type})${overdue}`);
      }
      console.log(`\n${all.length} task(s)`);
    });

  // ---- add ----
  taskCmd
    .command("add")
    .description("Create a new personal task")
    .option("--title <title>", "Task title (required)")
    .option("--due <days>", "Due in N days (default: 7)")
    .option("--type <type>", "Task type: task/reminder/birthday/event (default: task)")
    .option("--note <text>", "Optional note")
    .action(async (opts: { title?: string; due?: string; type?: string; note?: string }) => {
      if (!opts.title) {
        console.error("--title is required");
        process.exit(1);
      }
      const db = openCrmDb();
      if (!db) {
        console.error("SQLite unavailable.");
        process.exit(1);
      }

      const days = opts.due ? parseInt(opts.due, 10) : 7;
      const id = upsertFollowUp(db, {
        title: opts.title,
        due_at: Date.now() + days * 86_400_000,
        task_type: (opts.type as TaskType | undefined) ?? "task",
        note: opts.note,
      });
      console.log(`Task #${id} created: "${opts.title}" due in ${days} day(s)`);
    });

  // ---- done ----
  taskCmd
    .command("done <id>")
    .description("Mark a task as done")
    .action(async (id: string) => {
      const db = openCrmDb();
      if (!db) {
        console.error("SQLite unavailable.");
        process.exit(1);
      }
      markFollowUpDone(db, parseInt(id, 10));
      console.log(`Task #${id} marked done`);
    });

  // ---- cancel ----
  taskCmd
    .command("cancel <id>")
    .description("Cancel a task")
    .action(async (id: string) => {
      const db = openCrmDb();
      if (!db) {
        console.error("SQLite unavailable.");
        process.exit(1);
      }
      cancelFollowUp(db, parseInt(id, 10));
      console.log(`Task #${id} cancelled`);
    });

  // ---- snooze ----
  taskCmd
    .command("snooze <id> <days>")
    .description("Snooze a task for N days")
    .action(async (id: string, days: string) => {
      const db = openCrmDb();
      if (!db) {
        console.error("SQLite unavailable.");
        process.exit(1);
      }
      const until = Date.now() + parseInt(days, 10) * 86_400_000;
      snoozeFollowUp(db, parseInt(id, 10), until);
      console.log(`Task #${id} snoozed until ${new Date(until).toLocaleDateString()}`);
    });
}
