import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { generateNudges } from "../../intelligence/crm/crm-nudge.js";
import { computeRelationshipScore } from "../../intelligence/crm/crm-scorer.js";
import {
  cancelFollowUp,
  getContactSummary,
  listContactContext,
  listContacts,
  listInteractions,
  listAllPendingTasks,
  listPendingFollowUps,
  markFollowUpDone,
  openCrmDb,
  snoozeFollowUp,
  upsertFollowUp,
} from "../../intelligence/crm/crm-store.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

// ============================================================================
// Privacy gating — CRM data is personal; only available in direct sessions.
// ============================================================================

function isDirectSession(sessionKey?: string): boolean {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed?.rest) {
    return true;
  }
  const tokens = new Set(parsed.rest.toLowerCase().split(":").filter(Boolean));
  return !tokens.has("group") && !tokens.has("channel");
}

// ============================================================================
// Schema
// ============================================================================

const CrmQuerySchema = Type.Object({
  query: Type.String({
    description: "Natural language query about contacts, tasks, or your network.",
  }),
});

// ============================================================================
// Intent handlers
// ============================================================================

type Db = NonNullable<ReturnType<typeof openCrmDb>>;

function handlePersonLookup(db: Db, name: string): string {
  const contacts = listContacts(db, { search: name, limit: 3 });
  if (contacts.length === 0) {
    return `No contact found matching "${name}".`;
  }

  const contact = contacts[0];
  const score = computeRelationshipScore(db, contact);
  const summary = getContactSummary(db, contact.id);
  const interactions = listInteractions(db, contact.id, { limit: 5 });
  const context = listContactContext(db, contact.id, 5);

  const lines: string[] = [
    `**${contact.name}** <${contact.email}>`,
    `Type: ${contact.relationship_type}  Priority: ${contact.priority}  Score: ${score}/100`,
  ];
  if (contact.company) {
    lines.push(`Company: ${contact.company}${contact.role ? ` — ${contact.role}` : ""}`);
  }
  if (contact.notes) {
    lines.push(`Notes: ${contact.notes}`);
  }
  if (summary) {
    lines.push(`\nProfile:\n${summary.summary_text}`);
  }

  if (interactions.length > 0) {
    lines.push("\nRecent interactions:");
    for (const i of interactions) {
      const date = new Date(i.occurred_at).toLocaleDateString();
      lines.push(`  [${date}] ${i.type}: ${i.subject ?? "(no subject)"}`);
    }
  }

  if (context.length > 0) {
    lines.push("\nRecent context:");
    for (const c of context) {
      const date = new Date(c.occurred_at).toLocaleDateString();
      lines.push(`  [${date}/${c.source}] ${c.content.slice(0, 120)}`);
    }
  }

  return lines.join("\n");
}

function handleCompanyLookup(db: Db, company: string): string {
  const contacts = listContacts(db, { search: company, limit: 20 });
  const byCompany = contacts.filter((c) =>
    c.company?.toLowerCase().includes(company.toLowerCase()),
  );
  if (byCompany.length === 0) {
    return `No contacts at "${company}".`;
  }
  return byCompany.map((c) => `• ${c.name} <${c.email}> [${c.relationship_type}]`).join("\n");
}

function handleScheduleFollowUp(db: Db, nameOrEmail: string, daysFromNow: number): string {
  const contacts = listContacts(db, { search: nameOrEmail, limit: 1 });
  if (contacts.length === 0) {
    return `No contact found matching "${nameOrEmail}".`;
  }
  const contact = contacts[0];
  const dueAt = Date.now() + daysFromNow * 86_400_000;
  const id = upsertFollowUp(db, {
    contact_id: contact.id,
    title: `Follow up with ${contact.name}`,
    due_at: dueAt,
    task_type: "follow_up",
  });
  const dueStr = new Date(dueAt).toLocaleDateString();
  return `Follow-up #${id} scheduled with ${contact.name} on ${dueStr}.`;
}

function handleAddTask(db: Db, title: string, daysFromNow = 7): string {
  const dueAt = Date.now() + daysFromNow * 86_400_000;
  const id = upsertFollowUp(db, {
    title,
    due_at: dueAt,
    task_type: "task",
  });
  const dueStr = new Date(dueAt).toLocaleDateString();
  return `Task #${id} added: "${title}" — due ${dueStr}.`;
}

function handleTaskDone(db: Db, id: number): string {
  markFollowUpDone(db, id);
  return `Task #${id} marked as done.`;
}

function handleTaskSnooze(db: Db, id: number, days: number): string {
  const until = Date.now() + days * 86_400_000;
  snoozeFollowUp(db, id, until);
  return `Task #${id} snoozed until ${new Date(until).toLocaleDateString()}.`;
}

function handleTaskCancel(db: Db, id: number): string {
  cancelFollowUp(db, id);
  return `Task #${id} cancelled.`;
}

function handleTaskList(db: Db): string {
  const linked = listPendingFollowUps(db);
  const standalone = listAllPendingTasks(db);
  const all = [...linked, ...standalone]
    .filter((t, i, arr) => arr.findIndex((r) => r.id === t.id) === i)
    .toSorted((a, b) => a.due_at - b.due_at);

  if (all.length === 0) {
    return "No pending tasks.";
  }

  const now = Date.now();
  return all
    .map((t) => {
      const due = new Date(t.due_at).toLocaleDateString();
      const overdue = t.due_at < now ? " [OVERDUE]" : "";
      return `#${t.id}: ${t.title}  (due ${due} | ${t.task_type})${overdue}`;
    })
    .join("\n");
}

function handleNudgeList(db: Db): string {
  const { relationshipNudges, overdueTasks } = generateNudges(db, { maxNudges: 10 });
  const lines: string[] = [];

  if (relationshipNudges.length > 0) {
    lines.push(`**Relationship nudges (${relationshipNudges.length}):**`);
    for (const n of relationshipNudges) {
      const days = n.daysSinceLast !== null ? `${n.daysSinceLast}d ago` : "never";
      lines.push(`• ${n.name} [${n.relationshipType}] — last: ${days}. ${n.reason}`);
    }
  }

  if (overdueTasks.length > 0) {
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push(`**Overdue tasks (${overdueTasks.length}):**`);
    for (const t of overdueTasks) {
      const due = new Date(t.dueAt).toLocaleDateString();
      const who = t.contactName ? ` [${t.contactName}]` : "";
      lines.push(`• #${t.id}: ${t.title}${who} — was due ${due}`);
    }
  }

  return lines.length === 0
    ? "No nudges or overdue tasks — all relationships are in good shape!"
    : lines.join("\n");
}

function handleContactsByType(db: Db, type: string): string {
  const contacts = listContacts(db, {
    type: type as import("../../intelligence/crm/crm-store.js").RelationshipType,
    limit: 30,
  });
  if (contacts.length === 0) {
    return `No ${type} contacts found.`;
  }
  return contacts
    .map((c) => {
      const score = computeRelationshipScore(db, c);
      const company = c.company ? ` (${c.company})` : "";
      return `• ${c.name} <${c.email}>${company} — score ${score}/100`;
    })
    .join("\n");
}

function handleStats(db: Db): string {
  const all = listContacts(db, { limit: 100_000 });
  const byType: Record<string, number> = {};
  const byPriority: Record<string, number> = {};
  for (const c of all) {
    byType[c.relationship_type] = (byType[c.relationship_type] ?? 0) + 1;
    byPriority[c.priority] = (byPriority[c.priority] ?? 0) + 1;
  }

  const linked = listPendingFollowUps(db);
  const standalone = listAllPendingTasks(db);
  const tasks = [...linked, ...standalone].filter(
    (t, i, arr) => arr.findIndex((r) => r.id === t.id) === i,
  );
  const overdue = tasks.filter((t) => t.due_at < Date.now()).length;

  return [
    "**CRM Statistics**",
    `Total contacts: ${all.length}`,
    `By type: ${
      Object.entries(byType)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ") || "none"
    }`,
    `By priority: ${
      Object.entries(byPriority)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ") || "none"
    }`,
    `Pending tasks: ${tasks.length} (${overdue} overdue)`,
  ].join("\n");
}

function handleTextSearch(db: Db, query: string): string {
  const contacts = listContacts(db, { search: query, limit: 10 });
  if (contacts.length === 0) {
    return `No contacts found matching "${query}".`;
  }
  return contacts
    .map((c) => {
      const company = c.company ? ` (${c.company})` : "";
      return `• ${c.name} <${c.email}>${company} [${c.relationship_type}]`;
    })
    .join("\n");
}

// ============================================================================
// Intent detection
// ============================================================================

function parseDuration(amount: string, unit = "day"): number {
  const n = parseInt(amount, 10) || 1;
  const u = unit.toLowerCase();
  if (u.startsWith("week")) {
    return n * 7;
  }
  if (u.startsWith("month")) {
    return n * 30;
  }
  return n; // days
}

async function dispatch(db: Db, query: string): Promise<string> {
  let m: RegExpMatchArray | null;

  // 'tell me about X' / 'who is X' / 'show X'
  m = query.match(/(?:tell me about|who is|info on|profile of|show)\s+(.+)/i);
  if (m) {
    return handlePersonLookup(db, m[1].trim());
  }

  // 'who at Company' / 'contacts at Company'
  m = query.match(/(?:who|contacts|people)\s+(?:at|from|in)\s+(.+)/i);
  if (m) {
    return handleCompanyLookup(db, m[1].trim());
  }

  // 'follow up with X in N days/weeks/months'
  m = query.match(/follow.?up with\s+(.+?)\s+in\s+(\d+)\s+(day|week|month)/i);
  if (m) {
    return handleScheduleFollowUp(db, m[1].trim(), parseDuration(m[2], m[3]));
  }

  // 'remind me to X in N days'
  m = query.match(/remind me to\s+(.+?)\s+in\s+(\d+)\s+(day|week|month)/i);
  if (m) {
    return handleAddTask(db, m[1].trim(), parseDuration(m[2], m[3]));
  }

  // 'add task X'
  m = query.match(/add task[:\s]+(.+)/i);
  if (m) {
    return handleAddTask(db, m[1].trim());
  }

  // 'done #N' / 'complete #N'
  m = query.match(/(?:done|complete|finish)\s+#?(\d+)/i);
  if (m) {
    return handleTaskDone(db, parseInt(m[1], 10));
  }

  // 'cancel #N'
  m = query.match(/cancel\s+#?(\d+)/i);
  if (m) {
    return handleTaskCancel(db, parseInt(m[1], 10));
  }

  // 'snooze #N 3 days'
  m = query.match(/snooze\s+#?(\d+)\s+(\d+)\s*(day|week|month)?/i);
  if (m) {
    return handleTaskSnooze(db, parseInt(m[1], 10), parseDuration(m[2], m[3] ?? "day"));
  }

  // tasks / todo
  if (/(?:my tasks|todo|to-do|task list|pending tasks)/i.test(query)) {
    return handleTaskList(db);
  }

  // nudges / who needs attention
  if (/(?:who needs attention|nudge|check in|overdue)/i.test(query)) {
    return handleNudgeList(db);
  }

  // by relationship type
  const TYPES = ["friend", "family", "colleague", "professional", "other"] as const;
  m = query.match(/(?:my |all )?(friends?|family|colleagues?|professional|contacts?)/i);
  if (m) {
    const raw = m[1].toLowerCase().replace(/s$/, "").replace(/gue$/, "gue"); // colleague → colleague
    const type =
      raw === "friend"
        ? "friend"
        : raw === "family"
          ? "family"
          : raw === "colleague"
            ? "colleague"
            : raw === "professional"
              ? "professional"
              : null;
    if (type && TYPES.includes(type)) {
      return handleContactsByType(db, type);
    }
  }

  // stats
  if (/(?:stats|statistics|summary|overview|how many)/i.test(query)) {
    return handleStats(db);
  }

  // fallback: text search
  return handleTextSearch(db, query);
}

// ============================================================================
// Factory
// ============================================================================

export function createCrmTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool[] {
  // CRM data is personal — only available in direct sessions
  if (!isDirectSession(options.agentSessionKey)) {
    return [];
  }

  const db = openCrmDb();
  if (!db) {
    return [];
  }

  return [
    {
      label: "CRM",
      name: "crm_query",
      description:
        "Query and manage your personal CRM. Supports natural language:\n" +
        '  • "Tell me about Alice" — contact profile + history\n' +
        '  • "Who at Acme?" — contacts at a company\n' +
        '  • "Follow up with Bob in 2 weeks" — schedule a follow-up\n' +
        '  • "Remind me to call Alice in 3 days" — add a personal task\n' +
        '  • "Add task Review proposal" — standalone task\n' +
        '  • "My tasks" / "Todo" — list all pending tasks\n' +
        '  • "Done #12" / "Cancel #5" / "Snooze #7 3 days" — manage tasks\n' +
        '  • "Who needs attention?" / "Nudges" — relationship + overdue task nudges\n' +
        '  • "My friends" / "Colleagues" / "Family" — contacts by type\n' +
        '  • "Stats" — CRM statistics',
      parameters: CrmQuerySchema,
      execute: async (_toolCallId, params) => {
        const query = readStringParam(params, "query", { required: true });
        try {
          const result = await dispatch(db, query.trim());
          return jsonResult({ text: result });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return jsonResult({ error: `CRM query error: ${message}` });
        }
      },
    },
  ];
}
