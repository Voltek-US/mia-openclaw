import type { EmailProvider } from "./crm-provider.js";
import {
  getContact,
  getContactSummary,
  insertContactContext,
  listContactContext,
} from "./crm-store.js";

// ============================================================================
// Safety gate
// ============================================================================

function assertDraftEnabled(): void {
  const enabled = process.env.CRM_DRAFT_ENABLED?.trim().toLowerCase();
  if (enabled !== "true" && enabled !== "1") {
    throw new Error(
      "Draft creation is disabled. Set CRM_DRAFT_ENABLED=true to enable it.\n" +
        "This is a safety gate to prevent accidental email sends.",
    );
  }
}

// ============================================================================
// Types
// ============================================================================

export type DraftProposal = {
  proposed: true;
  toEmail: string;
  subject: string;
  draftText: string;
  /** Thread ID to reply into (if provided). */
  threadId?: string;
};

// ============================================================================
// Prompt building
// ============================================================================

function buildDraftPrompt(opts: {
  toEmail: string;
  subject: string;
  relationshipSummary: string | null;
  contextEntries: Array<{ content: string; source: string }>;
  threadMessages: Array<{ from: string; body: string }>;
  instruction?: string;
}): string {
  const contextSection =
    opts.contextEntries.length > 0
      ? opts.contextEntries.map((c) => `[${c.source}] ${c.content}`).join("\n")
      : "(no context entries)";

  const threadSection =
    opts.threadMessages.length > 0
      ? opts.threadMessages.map((m) => `From ${m.from}:\n${m.body}`).join("\n\n---\n\n")
      : "(no thread history)";

  return `
You are drafting an email on behalf of the user.

Recipient: ${opts.toEmail}
Subject: ${opts.subject}
${opts.instruction ? `\nInstruction from user: ${opts.instruction}` : ""}

Relationship profile:
${opts.relationshipSummary ?? "(no profile yet)"}

Recent context about this relationship:
${contextSection}

Thread history (most recent first):
${threadSection}

Write a natural, personal email draft. Match the tone of the existing relationship.
Do NOT include a subject line in the body. Do NOT use placeholders like [Your Name].
Write only the email body text, nothing else.
`.trim();
}

// ============================================================================
// Public API
// ============================================================================

/** Propose an email draft (phase 1). Returns the draft text for user review.
 *  Does NOT create any draft in the email client. */
export async function proposeDraft(
  db: import("node:sqlite").DatabaseSync,
  provider: EmailProvider,
  toEmail: string,
  opts: { subject: string; threadId?: string; instruction?: string },
): Promise<DraftProposal> {
  const contact = getContact(db, toEmail.toLowerCase());
  const summary = contact ? getContactSummary(db, contact.id) : null;
  const contextEntries = contact ? listContactContext(db, contact.id, 10) : [];

  let threadMessages: Array<{ from: string; body: string }> = [];
  if (opts.threadId) {
    try {
      const thread = await provider.fetchThread(opts.threadId);
      threadMessages = thread.messages.map((m) => ({ from: m.from, body: m.body }));
    } catch {
      // Thread fetch failed — continue without it
    }
  }

  const prompt = buildDraftPrompt({
    toEmail,
    subject: opts.subject,
    relationshipSummary: summary?.summary_text ?? null,
    contextEntries: contextEntries.map((c) => ({ content: c.content, source: c.source })),
    threadMessages,
    instruction: opts.instruction,
  });

  // Dynamic import per CLAUDE.md guardrail
  const { runLlm } = (await import("../../../shared/llm-router.js")) as {
    runLlm: (
      prompt: string,
      opts?: { model?: string; caller?: string },
    ) => Promise<{ text: string }>;
  };

  const { text } = await runLlm(prompt, { model: "claude-sonnet-4-6", caller: "crm-draft" });

  return {
    proposed: true,
    toEmail,
    subject: opts.subject,
    draftText: text.trim(),
    threadId: opts.threadId,
  };
}

/** Approve a proposed draft (phase 2). Creates the actual email draft in the provider.
 *  Requires CRM_DRAFT_ENABLED=true.
 *  Returns the provider's draft ID. */
export async function approveDraft(
  db: import("node:sqlite").DatabaseSync,
  provider: EmailProvider,
  proposal: DraftProposal,
): Promise<string> {
  assertDraftEnabled();

  const draftId = await provider.createDraft({
    to: proposal.toEmail,
    subject: proposal.subject,
    body: proposal.draftText,
    threadId: proposal.threadId,
  });

  // Log the draft to contact_context for relationship tracking
  const contact = getContact(db, proposal.toEmail.toLowerCase());
  if (contact) {
    insertContactContext(db, {
      contact_id: contact.id,
      content: `Draft email: ${proposal.subject}\n${proposal.draftText.slice(0, 500)}`,
      occurred_at: Date.now(),
      source: "draft",
    });
  }

  return draftId;
}
