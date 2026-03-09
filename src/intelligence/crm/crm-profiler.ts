import {
  getContactById,
  getContactSummary,
  listContactContext,
  listContacts,
  listInteractions,
  upsertContactSummary,
  type ContactRow,
} from "./crm-store.js";

const DEFAULT_MODEL = "claude-sonnet-4-6";

// ============================================================================
// Prompt building
// ============================================================================

function buildProfilePrompt(
  contact: ContactRow,
  interactions: Array<{ type: string; subject: string | null; occurred_at: number }>,
  contextEntries: Array<{ content: string; source: string; occurred_at: number }>,
): string {
  const interactionLines = interactions
    .map((i) => {
      const date = new Date(i.occurred_at).toISOString().split("T")[0];
      return `- [${date}] ${i.type}${i.subject ? `: ${i.subject}` : ""}`;
    })
    .join("\n");

  const contextLines = contextEntries
    .map((c) => {
      const date = new Date(c.occurred_at).toISOString().split("T")[0];
      return `[${date}/${c.source}] ${c.content}`;
    })
    .join("\n");

  return `
You are a personal relationship intelligence assistant. Write a concise, insightful
relationship summary for the following contact. Focus on:
1. How you know them and the nature of the relationship
2. Communication style and preferences (if evident)
3. Key topics, interests, or shared projects
4. What they need or value in a relationship
5. Any action items or context worth remembering

Keep the summary under 200 words. Be specific and personal — avoid generic platitudes.

Contact:
- Name: ${contact.name}
- Email: ${contact.email}
- Type: ${contact.relationship_type}
${contact.company ? `- Company/Context: ${contact.company}` : ""}
${contact.role ? `- Role: ${contact.role}` : ""}
${contact.notes ? `- Notes: ${contact.notes}` : ""}

Recent interactions (newest first):
${interactionLines || "(none recorded)"}

Context timeline:
${contextLines || "(no context entries)"}

Write the relationship summary now:
`.trim();
}

// ============================================================================
// Public API
// ============================================================================

/** Generate an LLM relationship profile for a contact and persist it. */
export async function generateProfile(
  db: import("node:sqlite").DatabaseSync,
  contactId: number,
  model: string = DEFAULT_MODEL,
): Promise<string | null> {
  const contact = getContactById(db, contactId);
  if (!contact) {
    return null;
  }

  const interactions = listInteractions(db, contactId, { limit: 10 });
  const contextEntries = listContactContext(db, contactId, 20);

  const prompt = buildProfilePrompt(contact, interactions, contextEntries);

  // Dynamic import per CLAUDE.md guardrail: do not mix static + dynamic imports
  // for the same module. shared/llm-router.js is only ever dynamically imported here.
  const { runLlm } = (await import("../../../shared/llm-router.js")) as {
    runLlm: (
      prompt: string,
      opts?: { model?: string; caller?: string },
    ) => Promise<{ text: string }>;
  };

  const { text } = await runLlm(prompt, { model, caller: "crm-profiler" });
  if (!text?.trim()) {
    return null;
  }

  upsertContactSummary(db, contactId, text.trim(), model);
  return text.trim();
}

/** Batch-generate profiles for contacts with stale or missing summaries.
 *  Skips contacts whose summary is fresher than staleDays. */
export async function batchGenerateProfiles(
  db: import("node:sqlite").DatabaseSync,
  opts: { staleDays?: number; model?: string; limit?: number } = {},
): Promise<number> {
  const { staleDays = 7, model = DEFAULT_MODEL, limit = 20 } = opts;
  const now = Date.now();
  const staleCutoff = now - staleDays * 86_400_000;

  const contacts = listContacts(db, { limit: 1_000 });
  let updated = 0;

  for (const contact of contacts) {
    if (updated >= limit) {
      break;
    }

    const summary = getContactSummary(db, contact.id);
    if (summary && summary.created_at > staleCutoff) {
      continue;
    } // fresh enough

    try {
      await generateProfile(db, contact.id, model);
      updated++;
    } catch {
      // log and continue — don't abort the batch on a single failure
      console.warn(`[crm-profiler] Failed to generate profile for ${contact.email}`);
    }
  }

  return updated;
}
