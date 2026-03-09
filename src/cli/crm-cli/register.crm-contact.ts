import type { Command } from "commander";
import { computeRelationshipScore } from "../../intelligence/crm/crm-scorer.js";
import {
  getContact,
  getContactSummary,
  listContactContext,
  listContacts,
  openCrmDb,
  upsertContact,
  type RelationshipType,
  type Priority,
} from "../../intelligence/crm/crm-store.js";

export function registerCrmContactCommands(parent: Command): void {
  const contactCmd = parent.command("contact").description("Manage contacts");

  // ---- list ----
  contactCmd
    .command("list")
    .description("List all contacts")
    .option(
      "--type <type>",
      "Filter by relationship type (friend/family/colleague/professional/other)",
    )
    .option("--priority <priority>", "Filter by priority (high/medium/low)")
    .option("--search <q>", "Search by name, email, or company")
    .option("--json", "Output as JSON", false)
    .action(async (opts: { type?: string; priority?: string; search?: string; json: boolean }) => {
      const db = openCrmDb();
      if (!db) {
        console.error("SQLite unavailable.");
        process.exit(1);
      }

      const contacts = listContacts(db, {
        type: opts.type as RelationshipType | undefined,
        priority: opts.priority as Priority | undefined,
        search: opts.search,
      });

      if (opts.json) {
        console.log(JSON.stringify(contacts, null, 2));
        return;
      }

      if (contacts.length === 0) {
        console.log("No contacts found.");
        return;
      }

      // Simple table output
      const lines = contacts.map((c) => {
        const score = computeRelationshipScore(db, c);
        const company = c.company ? ` (${c.company})` : "";
        return `${c.name.padEnd(25)} ${c.email.padEnd(35)} ${c.relationship_type.padEnd(14)} score:${String(score).padStart(3)}${company}`;
      });
      console.log(`${"Name".padEnd(25)} ${"Email".padEnd(35)} ${"Type".padEnd(14)} Score`);
      console.log("─".repeat(90));
      console.log(lines.join("\n"));
      console.log(`\n${contacts.length} contact(s)`);
    });

  // ---- show ----
  contactCmd
    .command("show <email>")
    .description("Show full contact profile")
    .action(async (email: string) => {
      const db = openCrmDb();
      if (!db) {
        console.error("SQLite unavailable.");
        process.exit(1);
      }

      const contact = getContact(db, email.toLowerCase());
      if (!contact) {
        console.error(`Contact not found: ${email}`);
        process.exit(1);
      }

      const score = computeRelationshipScore(db, contact);
      const summary = getContactSummary(db, contact.id);
      const context = listContactContext(db, contact.id, 10);

      console.log(`\n${contact.name} <${contact.email}>`);
      console.log(
        `Type:     ${contact.relationship_type}  |  Priority: ${contact.priority}  |  Score: ${score}/100`,
      );
      if (contact.company) {
        console.log(`Company:  ${contact.company}${contact.role ? ` — ${contact.role}` : ""}`);
      }
      if (contact.keep_in_touch_days) {
        console.log(`Cadence:  every ${contact.keep_in_touch_days} days`);
      }
      if (contact.notes) {
        console.log(`Notes:    ${contact.notes}`);
      }

      if (summary) {
        console.log(`\nRelationship profile:\n${summary.summary_text}`);
      }

      if (context.length > 0) {
        console.log("\nRecent context:");
        for (const c of context) {
          const date = new Date(c.occurred_at).toLocaleDateString();
          console.log(`  [${date}/${c.source}] ${c.content.slice(0, 120)}`);
        }
      }
    });

  // ---- edit ----
  contactCmd
    .command("edit <email>")
    .description("Edit a contact's type, priority, cadence, or notes")
    .option("--type <type>", "Relationship type")
    .option("--priority <priority>", "Priority (high/medium/low)")
    .option("--cadence <days>", "Keep-in-touch cadence in days")
    .option("--notes <text>", "Free-form personal notes")
    .action(
      async (
        email: string,
        opts: { type?: string; priority?: string; cadence?: string; notes?: string },
      ) => {
        const db = openCrmDb();
        if (!db) {
          console.error("SQLite unavailable.");
          process.exit(1);
        }

        const existing = getContact(db, email.toLowerCase());
        if (!existing) {
          console.error(`Contact not found: ${email}`);
          process.exit(1);
        }

        upsertContact(db, {
          name: existing.name,
          email: existing.email,
          relationship_type:
            (opts.type as RelationshipType | undefined) ?? existing.relationship_type,
          priority: (opts.priority as Priority | undefined) ?? existing.priority,
          keep_in_touch_days: opts.cadence
            ? parseInt(opts.cadence, 10)
            : existing.keep_in_touch_days,
          notes: opts.notes ?? existing.notes ?? undefined,
        });

        console.log(`Updated contact: ${existing.name} <${email}>`);
      },
    );
}
