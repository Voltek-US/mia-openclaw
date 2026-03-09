import readline from "node:readline/promises";
import type { CalendarProvider, EmailProvider } from "./crm-provider.js";
import {
  getContact,
  insertDiscoveryDecision,
  insertSkipPattern,
  matchSkipPatterns,
  suggestAutoMode,
  upsertContact,
  countDecisions,
  type RelationshipType,
} from "./crm-store.js";

// ============================================================================
// Types
// ============================================================================

export type ContactCandidate = {
  name?: string;
  email: string;
  source: string; // 'email' | 'calendar'
  snippet?: string; // context snippet from message/event
};

// ============================================================================
// Noise filters
// ============================================================================

/** Built-in noreply / automated sender patterns. */
const NOREPLY_KEYWORDS = [
  "noreply",
  "no-reply",
  "no.reply",
  "donotreply",
  "do-not-reply",
  "mailer-daemon",
  "postmaster",
  "bounce",
  "daemon",
  "notifications",
  "automated",
  "auto-confirm",
  "support@",
  "help@",
  "info@",
  "billing@",
  "invoices@",
  "receipts@",
  "orders@",
  "newsletter@",
  "updates@",
  "alerts@",
  "security@",
  "abuse@",
];

function isNoReplyEmail(email: string): boolean {
  const lower = email.toLowerCase();
  return NOREPLY_KEYWORDS.some((kw) => lower.includes(kw));
}

function getInternalDomains(): Set<string> {
  const env = process.env.CRM_INTERNAL_DOMAINS?.trim();
  if (!env) {
    return new Set();
  }
  return new Set(
    env
      .split(",")
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean),
  );
}

// ============================================================================
// Discovery pipeline
// ============================================================================

/** Scan recent email + calendar activity and return unfiltered contact candidates. */
export async function discoverCandidates(
  db: import("node:sqlite").DatabaseSync,
  emailProvider: EmailProvider,
  calProvider: CalendarProvider,
  since: Date,
  opts: { limit?: number } = {},
): Promise<ContactCandidate[]> {
  const { limit = 500 } = opts;
  const internalDomains = getInternalDomains();
  const seen = new Set<string>(); // deduplicate by email
  const candidates: ContactCandidate[] = [];

  function tryAdd(candidate: ContactCandidate): void {
    const email = candidate.email.trim().toLowerCase();
    if (!email || !email.includes("@")) {
      return;
    }
    if (seen.has(email)) {
      return;
    }
    seen.add(email);

    // Filter: already in contacts DB
    if (getContact(db, email)) {
      return;
    }

    // Filter: learned skip patterns
    if (matchSkipPatterns(db, email)) {
      return;
    }

    // Filter: noreply/automated senders
    if (isNoReplyEmail(email)) {
      return;
    }

    // Filter: internal company domains
    const domain = email.split("@")[1]?.toLowerCase();
    if (domain && internalDomains.has(domain)) {
      return;
    }

    candidates.push({ ...candidate, email });
  }

  // --- Email scan ---
  try {
    const messages = await emailProvider.fetchRecentMessages(since, limit);
    for (const msg of messages) {
      // Skip list-unsubscribe senders (newsletters)
      if (msg.listUnsubscribe) {
        continue;
      }
      tryAdd({
        email: msg.from.email,
        name: msg.from.name,
        source: "email",
        snippet: msg.subject || msg.snippet,
      });
    }
  } catch (err) {
    console.warn("[crm-discover] Email scan failed:", err instanceof Error ? err.message : err);
  }

  // --- Calendar scan ---
  try {
    const events = await calProvider.fetchRecentEvents(since);
    for (const event of events) {
      for (const attendeeEmail of event.attendees) {
        tryAdd({
          email: attendeeEmail,
          source: "calendar",
          snippet: event.title,
        });
      }
    }
  } catch (err) {
    console.warn("[crm-discover] Calendar scan failed:", err instanceof Error ? err.message : err);
  }

  return candidates;
}

// ============================================================================
// Interactive approval CLI
// ============================================================================

/** Run an interactive terminal approval flow for a list of candidates.
 *  Prompts (a)pprove / (r)eject / (s)kip-domain / (q)uit for each. */
export async function runInteractiveApproval(
  db: import("node:sqlite").DatabaseSync,
  candidates: ContactCandidate[],
  opts: { defaultType?: RelationshipType } = {},
): Promise<{ approved: number; rejected: number; skipped: number }> {
  if (candidates.length === 0) {
    console.log("[crm-discover] No new candidates to review.");
    return { approved: 0, rejected: 0, skipped: 0 };
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let approved = 0;
  let rejected = 0;
  let skipped = 0;

  try {
    console.log(`\n[crm-discover] ${candidates.length} new contact candidate(s) to review.\n`);

    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      const total = countDecisions(db);

      console.log(`--- [${i + 1}/${candidates.length}] ---`);
      console.log(`  Email:   ${c.email}`);
      if (c.name) {
        console.log(`  Name:    ${c.name}`);
      }
      console.log(`  Source:  ${c.source}`);
      if (c.snippet) {
        console.log(`  Context: ${c.snippet}`);
      }
      console.log();

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const answer = (await rl.question("  (a)pprove / (r)eject / (s)kip-domain / (q)uit: "))
          .trim()
          .toLowerCase();

        if (answer === "a" || answer === "approve") {
          const typeInput = (
            await rl.question("  Relationship type [friend/family/colleague/professional/other]: ")
          )
            .trim()
            .toLowerCase();
          const type: RelationshipType = (
            ["friend", "family", "colleague", "professional", "other"].includes(typeInput)
              ? typeInput
              : (opts.defaultType ?? "other")
          ) as RelationshipType;

          upsertContact(db, {
            name: c.name ?? c.email.split("@")[0] ?? c.email,
            email: c.email,
            relationship_type: type,
          });
          insertDiscoveryDecision(db, c.email, "approve");
          console.log(`  ✓ Added as ${type}\n`);
          approved++;
          break;
        } else if (answer === "r" || answer === "reject") {
          insertDiscoveryDecision(db, c.email, "reject");
          console.log("  ✗ Rejected\n");
          rejected++;
          break;
        } else if (answer === "s" || answer === "skip-domain") {
          const domain = c.email.split("@")[1];
          if (domain) {
            insertSkipPattern(db, domain, "domain");
            console.log(`  ✗ Added ${domain} to skip list\n`);
          }
          insertDiscoveryDecision(db, c.email, "reject");
          rejected++;
          break;
        } else if (answer === "q" || answer === "quit") {
          console.log("\n[crm-discover] Stopped early.");
          skipped += candidates.length - i;
          return { approved, rejected, skipped };
        } else {
          console.log("  Unknown input. Use a/r/s/q.");
        }
      }

      // After 50 total decisions, suggest auto-add mode
      if (total + 1 === 50 && suggestAutoMode(db)) {
        console.log(
          "\n💡 Tip: You have made 50+ decisions with a low reject rate.\n" +
            "   Set CRM_AUTO_MODE=true to skip this review and auto-add all candidates.\n",
        );
      }
    }
  } finally {
    rl.close();
  }

  return { approved, rejected, skipped };
}

// ============================================================================
// Auto-add mode (no interactive prompt)
// ============================================================================

/** Auto-add all candidates (used when CRM_AUTO_MODE=true or suggestAutoMode is true). */
export function autoAddCandidates(
  db: import("node:sqlite").DatabaseSync,
  candidates: ContactCandidate[],
  defaultType: RelationshipType = "other",
): number {
  let added = 0;
  for (const c of candidates) {
    upsertContact(db, {
      name: c.name ?? c.email.split("@")[0] ?? c.email,
      email: c.email,
      relationship_type: defaultType,
      auto_add: 1,
    });
    insertDiscoveryDecision(db, c.email, "approve");
    added++;
  }
  return added;
}
