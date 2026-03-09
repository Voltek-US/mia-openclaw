import {
  countInteractionsSince,
  getLastInteractionAt,
  listContacts,
  updateContactScore,
  type ContactRow,
  type RelationshipType,
} from "./crm-store.js";

// ============================================================================
// Cadence defaults per relationship type (days between expected contacts)
// ============================================================================

export const CADENCE_DEFAULTS: Record<RelationshipType, number> = {
  friend: 30,
  family: 14,
  colleague: 60,
  professional: 90,
  other: 60,
};

/** Resolve the effective keep-in-touch cadence for a contact (days). */
export function effectiveCadence(contact: ContactRow): number {
  return contact.keep_in_touch_days ?? CADENCE_DEFAULTS[contact.relationship_type];
}

// ============================================================================
// Score components
// ============================================================================

/** Recency score (0–1): 1.0 = interacted today; decays linearly to 0 at cadence*2 days. */
function recencyScore(daysSinceLast: number | null, cadenceDays: number): number {
  if (daysSinceLast === null) {
    return 0;
  } // never interacted
  const maxDays = cadenceDays * 2;
  return Math.max(0, 1 - daysSinceLast / maxDays);
}

/** Frequency score (0–1): based on interaction count over the last 90 days.
 *  Saturates at 8 interactions (weekly-ish). */
function frequencyScore(count90d: number): number {
  return Math.min(count90d / 8, 1);
}

/** Priority boost (0–1). */
function priorityBoost(priority: "high" | "medium" | "low"): number {
  if (priority === "high") {
    return 1;
  }
  if (priority === "medium") {
    return 0.5;
  }
  return 0.2;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// ============================================================================
// Public API
// ============================================================================

/** Compute the relationship score (0–100) for a single contact. */
export function computeRelationshipScore(
  db: import("node:sqlite").DatabaseSync,
  contact: ContactRow,
): number {
  const now = Date.now();
  const lastAt = getLastInteractionAt(db, contact.id);
  const daysSinceLast = lastAt !== null ? (now - lastAt) / 86_400_000 : null;
  const cadence = effectiveCadence(contact);
  const since90d = now - 90 * 86_400_000;
  const count90d = countInteractionsSince(db, contact.id, since90d);

  const raw =
    recencyScore(daysSinceLast, cadence) * 0.45 +
    frequencyScore(count90d) * 0.35 +
    priorityBoost(contact.priority) * 0.2;

  return clamp(Math.round(raw * 100), 0, 100);
}

/** Batch-update relationship scores for all contacts. */
export function batchUpdateScores(db: import("node:sqlite").DatabaseSync): void {
  const contacts = listContacts(db, { limit: 10_000 });
  for (const contact of contacts) {
    const score = computeRelationshipScore(db, contact);
    updateContactScore(db, contact.id, score);
  }
}
