import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearCrmDbCacheForTest,
  openCrmDb,
  upsertContact,
  getContact,
  getContactById,
  listContacts,
  updateContactScore,
  updateContactNotes,
  insertInteraction,
  listInteractions,
  getLastInteractionAt,
  countInteractionsSince,
  upsertFollowUp,
  listPendingFollowUps,
  listAllPendingTasks,
  markFollowUpDone,
  cancelFollowUp,
  snoozeFollowUp,
  insertContactContext,
  listContactContext,
  updateContextEmbedding,
  listContextWithoutEmbeddings,
  listContextWithEmbeddings,
  upsertContactSummary,
  getContactSummary,
  upsertMeeting,
  insertActionItem,
  matchSkipPatterns,
  insertSkipPattern,
  listSkipPatterns,
  insertDiscoveryDecision,
  countDecisions,
  suggestAutoMode,
} from "./crm-store.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = path.join(
    os.tmpdir(),
    `crm-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
});

afterEach(() => {
  clearCrmDbCacheForTest();
});

// ============================================================================
// openCrmDb
// ============================================================================

describe("openCrmDb", () => {
  it("opens a database and returns a handle", () => {
    const db = openCrmDb(tmpDir);
    expect(db).not.toBeNull();
  });

  it("returns the same handle on repeated calls (cache)", () => {
    const db1 = openCrmDb(tmpDir);
    const db2 = openCrmDb(tmpDir);
    expect(db1).toBe(db2);
  });
});

// ============================================================================
// contacts
// ============================================================================

describe("upsertContact / getContact", () => {
  it("inserts a new contact and retrieves it by email", () => {
    const db = openCrmDb(tmpDir)!;
    const id = upsertContact(db, { name: "Alice", email: "alice@example.com" });
    expect(id).toBeGreaterThan(0);

    const contact = getContact(db, "alice@example.com");
    expect(contact).not.toBeNull();
    expect(contact!.name).toBe("Alice");
    expect(contact!.relationship_type).toBe("other");
    expect(contact!.priority).toBe("medium");
  });

  it("upserts: updates existing contact fields but preserves email", () => {
    const db = openCrmDb(tmpDir)!;
    const id1 = upsertContact(db, {
      name: "Bob",
      email: "bob@example.com",
      relationship_type: "friend",
    });
    const id2 = upsertContact(db, {
      name: "Robert",
      email: "bob@example.com",
      company: "Acme",
    });
    expect(id1).toBe(id2);

    const contact = getContact(db, "bob@example.com");
    expect(contact!.name).toBe("Robert");
    expect(contact!.company).toBe("Acme");
    // relationship_type set on first insert survives update without override
    expect(contact!.relationship_type).toBe("friend");
  });

  it("listContacts filters by relationship type", () => {
    const db = openCrmDb(tmpDir)!;
    upsertContact(db, { name: "Alice", email: "alice@ex.com", relationship_type: "friend" });
    upsertContact(db, { name: "Bob", email: "bob@ex.com", relationship_type: "colleague" });

    const friends = listContacts(db, { type: "friend" });
    expect(friends).toHaveLength(1);
    expect(friends[0].name).toBe("Alice");
  });

  it("listContacts searches by name/email/company", () => {
    const db = openCrmDb(tmpDir)!;
    upsertContact(db, { name: "Alice Smith", email: "alice@corp.com", company: "MegaCorp" });
    upsertContact(db, { name: "Bob Jones", email: "bob@other.com" });

    const results = listContacts(db, { search: "MegaCorp" });
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("Alice Smith");
  });

  it("updateContactScore persists score", () => {
    const db = openCrmDb(tmpDir)!;
    const id = upsertContact(db, { name: "Carol", email: "carol@ex.com" });
    updateContactScore(db, id, 75.9);
    const contact = getContactById(db, id);
    expect(contact!.relationship_score).toBe(76);
  });

  it("updateContactNotes persists notes", () => {
    const db = openCrmDb(tmpDir)!;
    const id = upsertContact(db, { name: "Dan", email: "dan@ex.com" });
    updateContactNotes(db, id, "Loves hiking");
    const contact = getContactById(db, id);
    expect(contact!.notes).toBe("Loves hiking");
  });
});

// ============================================================================
// interactions
// ============================================================================

describe("insertInteraction / listInteractions", () => {
  it("inserts and lists interactions", () => {
    const db = openCrmDb(tmpDir)!;
    const contactId = upsertContact(db, { name: "Eve", email: "eve@ex.com" });
    insertInteraction(db, {
      contact_id: contactId,
      type: "email",
      subject: "Hello",
      occurred_at: 1000,
    });
    insertInteraction(db, {
      contact_id: contactId,
      type: "meeting",
      subject: "Catch up",
      occurred_at: 2000,
    });

    const rows = listInteractions(db, contactId);
    expect(rows).toHaveLength(2);
    expect(rows[0].occurred_at).toBe(2000); // newest first
  });

  it("deduplicates by message_id (returns null for duplicate)", () => {
    const db = openCrmDb(tmpDir)!;
    const contactId = upsertContact(db, { name: "Frank", email: "frank@ex.com" });
    const id1 = insertInteraction(db, {
      contact_id: contactId,
      type: "email",
      occurred_at: 1000,
      message_id: "msg-001",
    });
    const id2 = insertInteraction(db, {
      contact_id: contactId,
      type: "email",
      occurred_at: 1001,
      message_id: "msg-001",
    });
    expect(id1).not.toBeNull();
    expect(id2).toBeNull();

    const rows = listInteractions(db, contactId);
    expect(rows).toHaveLength(1);
  });

  it("getLastInteractionAt returns null when no interactions exist", () => {
    const db = openCrmDb(tmpDir)!;
    const id = upsertContact(db, { name: "Ghost", email: "ghost@ex.com" });
    expect(getLastInteractionAt(db, id)).toBeNull();
  });

  it("countInteractionsSince returns correct count", () => {
    const db = openCrmDb(tmpDir)!;
    const contactId = upsertContact(db, { name: "Hana", email: "hana@ex.com" });
    insertInteraction(db, { contact_id: contactId, type: "email", occurred_at: 100 });
    insertInteraction(db, { contact_id: contactId, type: "email", occurred_at: 200 });
    insertInteraction(db, { contact_id: contactId, type: "email", occurred_at: 300 });

    expect(countInteractionsSince(db, contactId, 200)).toBe(2);
  });
});

// ============================================================================
// follow_ups
// ============================================================================

describe("follow_ups", () => {
  it("creates a contact-linked follow-up", () => {
    const db = openCrmDb(tmpDir)!;
    const contactId = upsertContact(db, { name: "Iris", email: "iris@ex.com" });
    const id = upsertFollowUp(db, { contact_id: contactId, title: "Call Iris", due_at: 9999 });
    expect(id).toBeGreaterThan(0);

    const rows = listPendingFollowUps(db, { contactId });
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Call Iris");
  });

  it("creates a standalone personal task (no contact)", () => {
    const db = openCrmDb(tmpDir)!;
    upsertFollowUp(db, { title: "Buy birthday gift", due_at: 1000, task_type: "task" });

    const tasks = listAllPendingTasks(db);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].task_type).toBe("task");
    expect(tasks[0].contact_id).toBeNull();
  });

  it("markFollowUpDone changes status", () => {
    const db = openCrmDb(tmpDir)!;
    const id = upsertFollowUp(db, { title: "Do thing", due_at: 1000 });
    markFollowUpDone(db, id);

    const rows = listPendingFollowUps(db);
    expect(rows.find((r) => r.id === id)).toBeUndefined();
  });

  it("cancelFollowUp changes status to cancelled", () => {
    const db = openCrmDb(tmpDir)!;
    const id = upsertFollowUp(db, { title: "Maybe thing", due_at: 1000 });
    cancelFollowUp(db, id);

    const rows = listPendingFollowUps(db);
    expect(rows.find((r) => r.id === id)).toBeUndefined();
  });

  it("snoozeFollowUp sets snoozed status and timestamp", () => {
    const db = openCrmDb(tmpDir)!;
    const id = upsertFollowUp(db, { title: "Later thing", due_at: 1000 });
    snoozeFollowUp(db, id, 99999);

    const rows = listPendingFollowUps(db);
    expect(rows.find((r) => r.id === id)).toBeUndefined(); // no longer 'pending'
  });

  it("listPendingFollowUps filters by cutoff", () => {
    const db = openCrmDb(tmpDir)!;
    upsertFollowUp(db, { title: "Past due", due_at: 100 });
    upsertFollowUp(db, { title: "Future", due_at: 99999 });

    const overdue = listPendingFollowUps(db, { cutoff: 200 });
    expect(overdue).toHaveLength(1);
    expect(overdue[0].title).toBe("Past due");
  });
});

// ============================================================================
// contact_context
// ============================================================================

describe("contact_context", () => {
  it("inserts and retrieves context entries", () => {
    const db = openCrmDb(tmpDir)!;
    const contactId = upsertContact(db, { name: "Jack", email: "jack@ex.com" });
    insertContactContext(db, {
      contact_id: contactId,
      content: "Met at conference",
      occurred_at: 1000,
      source: "note",
    });
    const rows = listContactContext(db, contactId);
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe("Met at conference");
    expect(rows[0].embedding).toBeNull();
  });

  it("stores and retrieves embedding", () => {
    const db = openCrmDb(tmpDir)!;
    const contactId = upsertContact(db, { name: "Kay", email: "kay@ex.com" });
    const ctxId = insertContactContext(db, {
      contact_id: contactId,
      content: "Had lunch",
      occurred_at: 2000,
      source: "note",
      embedding: [0.1, 0.2, 0.3],
    });

    const rows = listContactContext(db, contactId);
    const parsed = JSON.parse(rows[0].embedding as unknown as string) as number[];
    expect(parsed).toEqual([0.1, 0.2, 0.3]);

    // updateContextEmbedding also works
    updateContextEmbedding(db, ctxId, [0.4, 0.5]);
    const updated = listContactContext(db, contactId);
    const parsedUpdated = JSON.parse(updated[0].embedding as unknown as string) as number[];
    expect(parsedUpdated).toEqual([0.4, 0.5]);
  });

  it("listContextWithoutEmbeddings only returns rows with null embedding", () => {
    const db = openCrmDb(tmpDir)!;
    const contactId = upsertContact(db, { name: "Lena", email: "lena@ex.com" });
    insertContactContext(db, {
      contact_id: contactId,
      content: "A",
      occurred_at: 1,
      source: "note",
    });
    insertContactContext(db, {
      contact_id: contactId,
      content: "B",
      occurred_at: 2,
      source: "note",
      embedding: [1.0],
    });

    const missing = listContextWithoutEmbeddings(db);
    expect(missing).toHaveLength(1);
    expect(missing[0].content).toBe("A");

    const withEmbed = listContextWithEmbeddings(db);
    expect(withEmbed).toHaveLength(1);
    expect(withEmbed[0].content).toBe("B");
  });
});

// ============================================================================
// contact_summaries
// ============================================================================

describe("contact_summaries", () => {
  it("upserts a summary (replaces old)", () => {
    const db = openCrmDb(tmpDir)!;
    const contactId = upsertContact(db, { name: "Mike", email: "mike@ex.com" });
    upsertContactSummary(db, contactId, "Good friend from college", "claude-sonnet-4-6");
    upsertContactSummary(db, contactId, "Updated summary", "claude-sonnet-4-6");

    const summary = getContactSummary(db, contactId);
    expect(summary?.summary_text).toBe("Updated summary");
  });

  it("getContactSummary returns null for contact with no summary", () => {
    const db = openCrmDb(tmpDir)!;
    const contactId = upsertContact(db, { name: "Nina", email: "nina@ex.com" });
    expect(getContactSummary(db, contactId)).toBeNull();
  });
});

// ============================================================================
// meetings
// ============================================================================

describe("meetings", () => {
  it("upserts a meeting by external_id", () => {
    const db = openCrmDb(tmpDir)!;
    const id = upsertMeeting(db, {
      external_id: "cal-001",
      title: "Team sync",
      start_time: 1000,
      end_time: 2000,
      transcript: null,
      summary: null,
      attendee_emails: JSON.stringify(["a@ex.com", "b@ex.com"]),
    });
    expect(id).toBeGreaterThan(0);

    // Upsert again with updated title — same id returned
    const id2 = upsertMeeting(db, {
      external_id: "cal-001",
      title: "Team sync (updated)",
      start_time: 1000,
      end_time: 2000,
      transcript: null,
      summary: null,
      attendee_emails: JSON.stringify(["a@ex.com"]),
    });
    expect(id2).toBe(id);
  });

  it("inserts action items for a meeting", () => {
    const db = openCrmDb(tmpDir)!;
    const meetingId = upsertMeeting(db, {
      external_id: "cal-002",
      title: "Planning",
      start_time: 1000,
      end_time: 2000,
      transcript: null,
      summary: null,
      attendee_emails: "[]",
    });
    const itemId = insertActionItem(db, {
      meeting_id: meetingId,
      text: "Send follow-up email",
      assignee_email: "me@ex.com",
      is_mine: 1,
      task_app_link: null,
      status: "open",
      created_at: Date.now(),
    });
    expect(itemId).toBeGreaterThan(0);
  });
});

// ============================================================================
// skip_patterns
// ============================================================================

describe("skip_patterns", () => {
  it("matches domain patterns", () => {
    const db = openCrmDb(tmpDir)!;
    insertSkipPattern(db, "newsletter.com", "domain");
    expect(matchSkipPatterns(db, "updates@newsletter.com")).toBe(true);
    expect(matchSkipPatterns(db, "alice@example.com")).toBe(false);
  });

  it("matches keyword patterns", () => {
    const db = openCrmDb(tmpDir)!;
    insertSkipPattern(db, "noreply", "keyword");
    expect(matchSkipPatterns(db, "noreply@service.com")).toBe(true);
    expect(matchSkipPatterns(db, "hello@friend.com")).toBe(false);
  });

  it("matches regex patterns", () => {
    const db = openCrmDb(tmpDir)!;
    insertSkipPattern(db, "^no[-.]?reply", "regex");
    expect(matchSkipPatterns(db, "no-reply@company.com")).toBe(true);
    expect(matchSkipPatterns(db, "noreply@company.com")).toBe(true);
    expect(matchSkipPatterns(db, "alice@company.com")).toBe(false);
  });

  it("ignores duplicate patterns", () => {
    const db = openCrmDb(tmpDir)!;
    insertSkipPattern(db, "spam.com", "domain");
    insertSkipPattern(db, "spam.com", "domain"); // should not throw
    expect(listSkipPatterns(db)).toHaveLength(1);
  });
});

// ============================================================================
// discovery_decisions + suggestAutoMode
// ============================================================================

describe("discovery_decisions", () => {
  it("countDecisions returns zero initially", () => {
    const db = openCrmDb(tmpDir)!;
    expect(countDecisions(db)).toBe(0);
  });

  it("suggestAutoMode requires >= 50 decisions with < 20% reject", () => {
    const db = openCrmDb(tmpDir)!;
    // Insert 49 approvals — not enough
    for (let i = 0; i < 49; i++) {
      insertDiscoveryDecision(db, `user${i}@ex.com`, "approve");
    }
    expect(suggestAutoMode(db)).toBe(false);

    // Insert 1 more approval (total 50, 0 rejects)
    insertDiscoveryDecision(db, "user49@ex.com", "approve");
    expect(suggestAutoMode(db)).toBe(true);
  });

  it("suggestAutoMode returns false when reject rate >= 20%", () => {
    const db = openCrmDb(tmpDir)!;
    // 40 approvals + 10 rejects = 20% reject rate
    for (let i = 0; i < 40; i++) {
      insertDiscoveryDecision(db, `user${i}@ex.com`, "approve");
    }
    for (let i = 0; i < 10; i++) {
      insertDiscoveryDecision(db, `reject${i}@ex.com`, "reject");
    }
    expect(suggestAutoMode(db)).toBe(false);
  });
});
