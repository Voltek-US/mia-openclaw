import { effectiveCadence } from "./crm-scorer.js";
import {
  getLastInteractionAt,
  listContacts,
  listPendingFollowUps,
  getContactById,
  type ContactRow,
} from "./crm-store.js";

// ============================================================================
// Types
// ============================================================================

export type NudgeRow = {
  contactId: number;
  name: string;
  email: string;
  relationshipType: string;
  reason: string;
  daysSinceLast: number | null;
  cadenceDays: number;
};

export type TaskRow = {
  id: number;
  title: string;
  taskType: string;
  dueAt: number;
  contactName?: string;
  contactEmail?: string;
};

export type NudgeResult = {
  relationshipNudges: NudgeRow[];
  overdueTasks: TaskRow[];
};

// ============================================================================
// Nudge generation
// ============================================================================

/** Generate relationship nudges and overdue task list. */
export function generateNudges(
  db: import("node:sqlite").DatabaseSync,
  opts: { maxNudges?: number } = {},
): NudgeResult {
  const { maxNudges = 20 } = opts;
  const now = Date.now();

  // --- Relationship nudges ---
  const contacts = listContacts(db, { limit: 5_000 });
  const relationshipNudges: NudgeRow[] = [];

  for (const contact of contacts) {
    const lastAt = getLastInteractionAt(db, contact.id);
    const cadence = effectiveCadence(contact);

    let daysSinceLast: number | null = null;
    if (lastAt !== null) {
      daysSinceLast = (now - lastAt) / 86_400_000;
    }

    const shouldNudge = isContactDueForNudge(contact, daysSinceLast, cadence);
    if (!shouldNudge) {
      continue;
    }

    relationshipNudges.push({
      contactId: contact.id,
      name: contact.name,
      email: contact.email,
      relationshipType: contact.relationship_type,
      reason: buildNudgeReason(contact, daysSinceLast, cadence),
      daysSinceLast: daysSinceLast !== null ? Math.round(daysSinceLast) : null,
      cadenceDays: cadence,
    });

    if (relationshipNudges.length >= maxNudges) {
      break;
    }
  }

  // Sort by most overdue first (longest time since contact relative to cadence)
  relationshipNudges.sort((a, b) => {
    const overdueA = (a.daysSinceLast ?? Infinity) / a.cadenceDays;
    const overdueB = (b.daysSinceLast ?? Infinity) / b.cadenceDays;
    return overdueB - overdueA;
  });

  // --- Overdue tasks ---
  const overdueFollowUps = listPendingFollowUps(db, { cutoff: now });
  const overdueTasks: TaskRow[] = overdueFollowUps.map((row) => {
    let contactName: string | undefined;
    let contactEmail: string | undefined;
    if (row.contact_id !== null) {
      const contact = getContactById(db, row.contact_id);
      contactName = contact?.name;
      contactEmail = contact?.email;
    }
    return {
      id: row.id,
      title: row.title,
      taskType: row.task_type,
      dueAt: row.due_at,
      contactName,
      contactEmail,
    };
  });

  return { relationshipNudges, overdueTasks };
}

// ============================================================================
// Helpers
// ============================================================================

function isContactDueForNudge(
  contact: ContactRow,
  daysSinceLast: number | null,
  cadenceDays: number,
): boolean {
  if (contact.relationship_score < 40) {
    return true;
  }
  if (daysSinceLast === null) {
    return true;
  } // never interacted
  return daysSinceLast > cadenceDays;
}

function buildNudgeReason(
  contact: ContactRow,
  daysSinceLast: number | null,
  cadenceDays: number,
): string {
  if (daysSinceLast === null) {
    return `No interaction recorded yet`;
  }
  const days = Math.round(daysSinceLast);
  if (days > cadenceDays) {
    return `${days}d since last contact (goal: every ${cadenceDays}d)`;
  }
  return `Relationship score low (${contact.relationship_score}/100)`;
}
