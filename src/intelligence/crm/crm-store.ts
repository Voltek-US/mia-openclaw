import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireNodeSqlite } from "../../memory/sqlite.js";

// ============================================================================
// DB path resolution
// ============================================================================

export function resolveCrmDbDir(): string {
  const override = process.env.CRM_DB_DIR?.trim();
  if (override) {
    return path.resolve(override);
  }
  const home = process.env.OPENCLAW_HOME ?? path.join(os.homedir(), ".openclaw");
  return path.join(home, "crm");
}

// ============================================================================
// DB Handle Cache (per-directory)
// ============================================================================

const DB_CACHE = new Map<string, import("node:sqlite").DatabaseSync>();

/** Open (or reuse a cached) DatabaseSync for the CRM store.
 *  Returns null if node:sqlite is unavailable. */
export function openCrmDb(dir?: string): import("node:sqlite").DatabaseSync | null {
  const dbDir = dir ?? resolveCrmDbDir();
  const cached = DB_CACHE.get(dbDir);
  if (cached) {
    return cached;
  }

  let DatabaseSync: typeof import("node:sqlite").DatabaseSync;
  try {
    ({ DatabaseSync } = requireNodeSqlite());
  } catch {
    return null;
  }
  try {
    fs.mkdirSync(dbDir, { recursive: true });
  } catch {
    // ignore — dir may already exist
  }
  const dbPath = path.join(dbDir, "crm.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  ensureCrmDbSchema(db);
  DB_CACHE.set(dbDir, db);
  return db;
}

/** Clear all cached DB handles (used in tests to reset state between runs). */
export function clearCrmDbCacheForTest(): void {
  for (const db of DB_CACHE.values()) {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
  DB_CACHE.clear();
}

// ============================================================================
// Schema
// ============================================================================

/** Initialize the CRM schema. Idempotent — safe to call on every open. */
export function ensureCrmDbSchema(db: import("node:sqlite").DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // contacts — friends, family, colleagues, professional, other
  db.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      name               TEXT    NOT NULL,
      email              TEXT    NOT NULL UNIQUE,
      company            TEXT,
      role               TEXT,
      relationship_type  TEXT    NOT NULL DEFAULT 'other'
                                 CHECK(relationship_type IN
                                   ('friend','family','colleague','professional','other')),
      priority           TEXT    NOT NULL DEFAULT 'medium'
                                 CHECK(priority IN ('high','medium','low')),
      relationship_score INTEGER NOT NULL DEFAULT 0,
      keep_in_touch_days INTEGER,
      auto_add           INTEGER NOT NULL DEFAULT 0,
      notes              TEXT,
      created_at         INTEGER NOT NULL,
      updated_at         INTEGER NOT NULL
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_contacts_email    ON contacts(email);`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_contacts_company  ON contacts(company) WHERE company IS NOT NULL;`,
  );
  db.exec(`CREATE INDEX IF NOT EXISTS idx_contacts_score    ON contacts(relationship_score);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_contacts_type     ON contacts(relationship_type);`);

  // interactions — email / meeting / call
  db.exec(`
    CREATE TABLE IF NOT EXISTS interactions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id  INTEGER NOT NULL REFERENCES contacts(id),
      type        TEXT    NOT NULL CHECK(type IN ('email','meeting','call')),
      subject     TEXT,
      occurred_at INTEGER NOT NULL,
      message_id  TEXT    UNIQUE
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_interactions_contact_id  ON interactions(contact_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_interactions_occurred_at ON interactions(occurred_at);`);

  // follow_ups — personal tasks and contact follow-ups (contact_id optional)
  db.exec(`
    CREATE TABLE IF NOT EXISTS follow_ups (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id     INTEGER REFERENCES contacts(id),
      title          TEXT    NOT NULL,
      due_at         INTEGER NOT NULL,
      snoozed_until  INTEGER,
      status         TEXT    NOT NULL DEFAULT 'pending'
                             CHECK(status IN ('pending','done','snoozed','cancelled')),
      note           TEXT,
      task_type      TEXT    NOT NULL DEFAULT 'follow_up'
                             CHECK(task_type IN ('follow_up','task','reminder','birthday','event')),
      created_at     INTEGER NOT NULL
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_follow_ups_contact_id ON follow_ups(contact_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_follow_ups_due_at     ON follow_ups(due_at);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_follow_ups_status     ON follow_ups(status);`);

  // contact_context — timeline entries with optional vector embeddings
  db.exec(`
    CREATE TABLE IF NOT EXISTS contact_context (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id  INTEGER NOT NULL REFERENCES contacts(id),
      content     TEXT    NOT NULL,
      occurred_at INTEGER NOT NULL,
      source      TEXT    NOT NULL,
      embedding   BLOB
    );
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_contact_context_contact_id  ON contact_context(contact_id);`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_contact_context_occurred_at ON contact_context(occurred_at);`,
  );

  // contact_summaries — LLM-generated relationship profiles
  db.exec(`
    CREATE TABLE IF NOT EXISTS contact_summaries (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id   INTEGER NOT NULL REFERENCES contacts(id),
      summary_text TEXT    NOT NULL,
      model        TEXT    NOT NULL,
      created_at   INTEGER NOT NULL
    );
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_contact_summaries_contact_id ON contact_summaries(contact_id);`,
  );

  // meetings — schema ready; recorder sync deferred to a later script
  db.exec(`
    CREATE TABLE IF NOT EXISTS meetings (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      external_id     TEXT    NOT NULL UNIQUE,
      title           TEXT    NOT NULL,
      start_time      INTEGER NOT NULL,
      end_time        INTEGER NOT NULL,
      transcript      TEXT,
      summary         TEXT,
      attendee_emails TEXT    NOT NULL DEFAULT '[]'
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_meetings_start_time ON meetings(start_time);`);

  // meeting_action_items
  db.exec(`
    CREATE TABLE IF NOT EXISTS meeting_action_items (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id     INTEGER NOT NULL REFERENCES meetings(id),
      text           TEXT    NOT NULL,
      assignee_email TEXT,
      is_mine        INTEGER NOT NULL DEFAULT 0,
      task_app_link  TEXT,
      status         TEXT    NOT NULL DEFAULT 'open'
                             CHECK(status IN ('open','done','cancelled')),
      created_at     INTEGER NOT NULL
    );
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_meeting_action_items_meeting_id ON meeting_action_items(meeting_id);`,
  );

  // company_news
  db.exec(`
    CREATE TABLE IF NOT EXISTS company_news (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      company_name     TEXT    NOT NULL,
      headline         TEXT    NOT NULL,
      url              TEXT,
      published_at     INTEGER NOT NULL,
      created_at       INTEGER NOT NULL
    );
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_company_news_company_name ON company_news(company_name);`,
  );

  // skip_patterns — learned from approve/reject decisions
  db.exec(`
    CREATE TABLE IF NOT EXISTS skip_patterns (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      pattern      TEXT    NOT NULL UNIQUE,
      pattern_type TEXT    NOT NULL CHECK(pattern_type IN ('domain','regex','keyword')),
      hit_count    INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL
    );
  `);

  // discovery_decisions — approve / reject log for auto-mode learning
  db.exec(`
    CREATE TABLE IF NOT EXISTS discovery_decisions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      email      TEXT    NOT NULL,
      decision   TEXT    NOT NULL CHECK(decision IN ('approve','reject')),
      created_at INTEGER NOT NULL
    );
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_discovery_decisions_email ON discovery_decisions(email);`,
  );

  db.exec(`INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('schema_version', '1');`);
}

// ============================================================================
// Types
// ============================================================================

export type RelationshipType = "friend" | "family" | "colleague" | "professional" | "other";
export type Priority = "high" | "medium" | "low";
export type TaskType = "follow_up" | "task" | "reminder" | "birthday" | "event";
export type TaskStatus = "pending" | "done" | "snoozed" | "cancelled";

export type ContactRow = {
  id: number;
  name: string;
  email: string;
  company: string | null;
  role: string | null;
  relationship_type: RelationshipType;
  priority: Priority;
  relationship_score: number;
  keep_in_touch_days: number | null;
  auto_add: number;
  notes: string | null;
  created_at: number;
  updated_at: number;
};

export type InteractionRow = {
  id: number;
  contact_id: number;
  type: "email" | "meeting" | "call";
  subject: string | null;
  occurred_at: number;
  message_id: string | null;
};

export type FollowUpRow = {
  id: number;
  contact_id: number | null;
  title: string;
  due_at: number;
  snoozed_until: number | null;
  status: TaskStatus;
  note: string | null;
  task_type: TaskType;
  created_at: number;
};

export type ContextRow = {
  id: number;
  contact_id: number;
  content: string;
  occurred_at: number;
  source: string;
  embedding: Buffer | null;
};

export type SummaryRow = {
  id: number;
  contact_id: number;
  summary_text: string;
  model: string;
  created_at: number;
};

export type MeetingRow = {
  id: number;
  external_id: string;
  title: string;
  start_time: number;
  end_time: number;
  transcript: string | null;
  summary: string | null;
  attendee_emails: string;
};

export type ActionItemRow = {
  id: number;
  meeting_id: number;
  text: string;
  assignee_email: string | null;
  is_mine: number;
  task_app_link: string | null;
  status: string;
  created_at: number;
};

export type NewsRow = {
  id: number;
  company_name: string;
  headline: string;
  url: string | null;
  published_at: number;
  created_at: number;
};

export type SkipPatternRow = {
  id: number;
  pattern: string;
  pattern_type: "domain" | "regex" | "keyword";
  hit_count: number;
  created_at: number;
};

// ============================================================================
// contacts CRUD
// ============================================================================

export type UpsertContactFields = {
  name: string;
  email: string;
  company?: string | null;
  role?: string | null;
  relationship_type?: RelationshipType;
  priority?: Priority;
  keep_in_touch_days?: number | null;
  auto_add?: number;
  notes?: string | null;
};

/** Upsert a contact by email. Returns the contact id. */
export function upsertContact(
  db: import("node:sqlite").DatabaseSync,
  fields: UpsertContactFields,
): number {
  const now = Date.now();
  const existing = db
    .prepare("SELECT id, created_at FROM contacts WHERE email = ?")
    .get(fields.email) as { id: number; created_at: number } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE contacts SET
        name               = ?,
        company            = COALESCE(?, company),
        role               = COALESCE(?, role),
        relationship_type  = COALESCE(?, relationship_type),
        priority           = COALESCE(?, priority),
        keep_in_touch_days = COALESCE(?, keep_in_touch_days),
        auto_add           = COALESCE(?, auto_add),
        notes              = COALESCE(?, notes),
        updated_at         = ?
      WHERE id = ?
    `).run(
      fields.name,
      fields.company ?? null,
      fields.role ?? null,
      fields.relationship_type ?? null,
      fields.priority ?? null,
      fields.keep_in_touch_days ?? null,
      fields.auto_add ?? null,
      fields.notes ?? null,
      now,
      existing.id,
    );
    return existing.id;
  }

  const result = db
    .prepare(`
    INSERT INTO contacts
      (name, email, company, role, relationship_type, priority,
       relationship_score, keep_in_touch_days, auto_add, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
  `)
    .run(
      fields.name,
      fields.email,
      fields.company ?? null,
      fields.role ?? null,
      fields.relationship_type ?? "other",
      fields.priority ?? "medium",
      fields.keep_in_touch_days ?? null,
      fields.auto_add ?? 0,
      fields.notes ?? null,
      now,
      now,
    );
  return Number(result.lastInsertRowid);
}

/** Get a contact by email. */
export function getContact(
  db: import("node:sqlite").DatabaseSync,
  email: string,
): ContactRow | null {
  return (
    (db.prepare("SELECT * FROM contacts WHERE email = ?").get(email) as ContactRow | undefined) ??
    null
  );
}

/** Get a contact by id. */
export function getContactById(
  db: import("node:sqlite").DatabaseSync,
  id: number,
): ContactRow | null {
  return (
    (db.prepare("SELECT * FROM contacts WHERE id = ?").get(id) as ContactRow | undefined) ?? null
  );
}

/** List contacts with optional filters. */
export function listContacts(
  db: import("node:sqlite").DatabaseSync,
  opts: {
    type?: RelationshipType;
    priority?: Priority;
    search?: string;
    limit?: number;
  } = {},
): ContactRow[] {
  const { type, priority, search, limit = 200 } = opts;
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (type) {
    conditions.push("relationship_type = ?");
    params.push(type);
  }
  if (priority) {
    conditions.push("priority = ?");
    params.push(priority);
  }
  if (search) {
    conditions.push("(name LIKE ? OR email LIKE ? OR company LIKE ?)");
    const pattern = `%${search}%`;
    params.push(pattern, pattern, pattern);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return db
    .prepare(`SELECT * FROM contacts ${where} ORDER BY relationship_score DESC LIMIT ?`)
    .all(...params, limit) as ContactRow[];
}

/** Update the relationship score for a contact. Also bumps updated_at. */
export function updateContactScore(
  db: import("node:sqlite").DatabaseSync,
  id: number,
  score: number,
): void {
  db.prepare("UPDATE contacts SET relationship_score = ?, updated_at = ? WHERE id = ?").run(
    Math.round(score),
    Date.now(),
    id,
  );
}

/** Update free-form notes for a contact. */
export function updateContactNotes(
  db: import("node:sqlite").DatabaseSync,
  id: number,
  notes: string,
): void {
  db.prepare("UPDATE contacts SET notes = ?, updated_at = ? WHERE id = ?").run(
    notes,
    Date.now(),
    id,
  );
}

// ============================================================================
// interactions CRUD
// ============================================================================

export type InsertInteractionFields = {
  contact_id: number;
  type: "email" | "meeting" | "call";
  subject?: string | null;
  occurred_at: number;
  message_id?: string | null;
};

/** Insert an interaction. Silently ignores duplicate message_id. Returns row id or null if deduped. */
export function insertInteraction(
  db: import("node:sqlite").DatabaseSync,
  row: InsertInteractionFields,
): number | null {
  if (row.message_id) {
    const existing = db
      .prepare("SELECT id FROM interactions WHERE message_id = ?")
      .get(row.message_id) as { id: number } | undefined;
    if (existing) {
      return null;
    }
  }
  const result = db
    .prepare(`
    INSERT INTO interactions (contact_id, type, subject, occurred_at, message_id)
    VALUES (?, ?, ?, ?, ?)
  `)
    .run(row.contact_id, row.type, row.subject ?? null, row.occurred_at, row.message_id ?? null);
  return Number(result.lastInsertRowid);
}

/** List interactions for a contact, newest first. */
export function listInteractions(
  db: import("node:sqlite").DatabaseSync,
  contactId: number,
  opts: { limit?: number; since?: number } = {},
): InteractionRow[] {
  const { limit = 50, since } = opts;
  if (since !== undefined) {
    return db
      .prepare(
        "SELECT * FROM interactions WHERE contact_id = ? AND occurred_at >= ? ORDER BY occurred_at DESC LIMIT ?",
      )
      .all(contactId, since, limit) as InteractionRow[];
  }
  return db
    .prepare("SELECT * FROM interactions WHERE contact_id = ? ORDER BY occurred_at DESC LIMIT ?")
    .all(contactId, limit) as InteractionRow[];
}

/** Get the timestamp of the most recent interaction for a contact. Returns null if none. */
export function getLastInteractionAt(
  db: import("node:sqlite").DatabaseSync,
  contactId: number,
): number | null {
  const row = db
    .prepare(
      "SELECT occurred_at FROM interactions WHERE contact_id = ? ORDER BY occurred_at DESC LIMIT 1",
    )
    .get(contactId) as { occurred_at: number } | undefined;
  return row?.occurred_at ?? null;
}

/** Count interactions for a contact since a given timestamp. */
export function countInteractionsSince(
  db: import("node:sqlite").DatabaseSync,
  contactId: number,
  since: number,
): number {
  const row = db
    .prepare("SELECT COUNT(*) as count FROM interactions WHERE contact_id = ? AND occurred_at >= ?")
    .get(contactId, since) as { count: number };
  return row.count;
}

// ============================================================================
// follow_ups CRUD
// ============================================================================

export type UpsertFollowUpFields = {
  contact_id?: number | null;
  title: string;
  due_at: number;
  note?: string | null;
  task_type?: TaskType;
};

/** Upsert a follow-up or standalone task. Returns the row id. */
export function upsertFollowUp(
  db: import("node:sqlite").DatabaseSync,
  fields: UpsertFollowUpFields,
): number {
  const now = Date.now();
  const result = db
    .prepare(`
    INSERT INTO follow_ups (contact_id, title, due_at, status, note, task_type, created_at)
    VALUES (?, ?, ?, 'pending', ?, ?, ?)
  `)
    .run(
      fields.contact_id ?? null,
      fields.title,
      fields.due_at,
      fields.note ?? null,
      fields.task_type ?? "follow_up",
      now,
    );
  return Number(result.lastInsertRowid);
}

/** List pending follow-ups, optionally filtered. */
export function listPendingFollowUps(
  db: import("node:sqlite").DatabaseSync,
  opts: { contactId?: number; type?: TaskType; cutoff?: number } = {},
): FollowUpRow[] {
  const { contactId, type, cutoff } = opts;
  const conditions: string[] = ["status = 'pending'"];
  const params: (string | number)[] = [];

  if (contactId !== undefined) {
    conditions.push("contact_id = ?");
    params.push(contactId);
  }
  if (type) {
    conditions.push("task_type = ?");
    params.push(type);
  }
  if (cutoff !== undefined) {
    conditions.push("due_at <= ?");
    params.push(cutoff);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  return db
    .prepare(`SELECT * FROM follow_ups ${where} ORDER BY due_at ASC`)
    .all(...params) as FollowUpRow[];
}

/** List standalone personal tasks (no contact linked). */
export function listAllPendingTasks(db: import("node:sqlite").DatabaseSync): FollowUpRow[] {
  return db
    .prepare(
      "SELECT * FROM follow_ups WHERE contact_id IS NULL AND status = 'pending' ORDER BY due_at ASC",
    )
    .all() as FollowUpRow[];
}

/** Mark a follow-up as done. */
export function markFollowUpDone(db: import("node:sqlite").DatabaseSync, id: number): void {
  db.prepare("UPDATE follow_ups SET status = 'done' WHERE id = ?").run(id);
}

/** Cancel a follow-up. */
export function cancelFollowUp(db: import("node:sqlite").DatabaseSync, id: number): void {
  db.prepare("UPDATE follow_ups SET status = 'cancelled' WHERE id = ?").run(id);
}

/** Snooze a follow-up until a future timestamp. */
export function snoozeFollowUp(
  db: import("node:sqlite").DatabaseSync,
  id: number,
  until: number,
): void {
  db.prepare("UPDATE follow_ups SET status = 'snoozed', snoozed_until = ? WHERE id = ?").run(
    until,
    id,
  );
}

// ============================================================================
// contact_context CRUD
// ============================================================================

export type InsertContextFields = {
  contact_id: number;
  content: string;
  occurred_at: number;
  source: string;
  embedding?: number[] | null;
};

/** Insert a contact context entry. Returns the row id. */
export function insertContactContext(
  db: import("node:sqlite").DatabaseSync,
  fields: InsertContextFields,
): number {
  const embeddingBlob = fields.embedding ? JSON.stringify(fields.embedding) : null;
  const result = db
    .prepare(`
    INSERT INTO contact_context (contact_id, content, occurred_at, source, embedding)
    VALUES (?, ?, ?, ?, ?)
  `)
    .run(fields.contact_id, fields.content, fields.occurred_at, fields.source, embeddingBlob);
  return Number(result.lastInsertRowid);
}

/** List context entries for a contact, newest first. */
export function listContactContext(
  db: import("node:sqlite").DatabaseSync,
  contactId: number,
  limit = 20,
): ContextRow[] {
  return db
    .prepare("SELECT * FROM contact_context WHERE contact_id = ? ORDER BY occurred_at DESC LIMIT ?")
    .all(contactId, limit) as ContextRow[];
}

/** Update the embedding for a context entry. */
export function updateContextEmbedding(
  db: import("node:sqlite").DatabaseSync,
  id: number,
  embedding: number[],
): void {
  db.prepare("UPDATE contact_context SET embedding = ? WHERE id = ?").run(
    JSON.stringify(embedding),
    id,
  );
}

/** List context entries that have no embedding yet (for batch embed jobs). */
export function listContextWithoutEmbeddings(
  db: import("node:sqlite").DatabaseSync,
  limit = 100,
): ContextRow[] {
  return db
    .prepare(
      "SELECT * FROM contact_context WHERE embedding IS NULL ORDER BY occurred_at DESC LIMIT ?",
    )
    .all(limit) as ContextRow[];
}

/** List all context entries that have an embedding (for semantic search). */
export function listContextWithEmbeddings(
  db: import("node:sqlite").DatabaseSync,
  limit = 2000,
): ContextRow[] {
  return db
    .prepare(
      "SELECT * FROM contact_context WHERE embedding IS NOT NULL ORDER BY occurred_at DESC LIMIT ?",
    )
    .all(limit) as ContextRow[];
}

// ============================================================================
// contact_summaries CRUD
// ============================================================================

/** Upsert a contact summary (delete old + insert). */
export function upsertContactSummary(
  db: import("node:sqlite").DatabaseSync,
  contactId: number,
  summaryText: string,
  model: string,
): void {
  db.prepare("DELETE FROM contact_summaries WHERE contact_id = ?").run(contactId);
  db.prepare(`
    INSERT INTO contact_summaries (contact_id, summary_text, model, created_at)
    VALUES (?, ?, ?, ?)
  `).run(contactId, summaryText, model, Date.now());
}

/** Get the most recent summary for a contact. */
export function getContactSummary(
  db: import("node:sqlite").DatabaseSync,
  contactId: number,
): SummaryRow | null {
  return (
    (db
      .prepare(
        "SELECT * FROM contact_summaries WHERE contact_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(contactId) as SummaryRow | undefined) ?? null
  );
}

// ============================================================================
// meetings CRUD
// ============================================================================

/** Upsert a meeting by external_id. Returns the meeting id. */
export function upsertMeeting(
  db: import("node:sqlite").DatabaseSync,
  row: Omit<MeetingRow, "id">,
): number {
  const result = db
    .prepare(`
    INSERT INTO meetings (external_id, title, start_time, end_time, transcript, summary, attendee_emails)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(external_id) DO UPDATE SET
      title           = excluded.title,
      end_time        = excluded.end_time,
      transcript      = COALESCE(excluded.transcript, transcript),
      summary         = COALESCE(excluded.summary, summary),
      attendee_emails = excluded.attendee_emails
  `)
    .run(
      row.external_id,
      row.title,
      row.start_time,
      row.end_time,
      row.transcript ?? null,
      row.summary ?? null,
      row.attendee_emails,
    );
  if (result.lastInsertRowid) {
    return Number(result.lastInsertRowid);
  }
  // On conflict: fetch the existing id
  const existing = db
    .prepare("SELECT id FROM meetings WHERE external_id = ?")
    .get(row.external_id) as { id: number };
  return existing.id;
}

/** Insert a meeting action item. Returns the row id. */
export function insertActionItem(
  db: import("node:sqlite").DatabaseSync,
  row: Omit<ActionItemRow, "id">,
): number {
  const result = db
    .prepare(`
    INSERT INTO meeting_action_items
      (meeting_id, text, assignee_email, is_mine, task_app_link, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
    .run(
      row.meeting_id,
      row.text,
      row.assignee_email ?? null,
      row.is_mine,
      row.task_app_link ?? null,
      row.status,
      row.created_at,
    );
  return Number(result.lastInsertRowid);
}

// ============================================================================
// company_news CRUD
// ============================================================================

/** Insert a company news item. Returns the row id. */
export function insertCompanyNews(
  db: import("node:sqlite").DatabaseSync,
  row: Omit<NewsRow, "id">,
): number {
  const result = db
    .prepare(`
    INSERT INTO company_news (company_name, headline, url, published_at, created_at)
    VALUES (?, ?, ?, ?, ?)
  `)
    .run(row.company_name, row.headline, row.url ?? null, row.published_at, row.created_at);
  return Number(result.lastInsertRowid);
}

/** List company news for a given company name. */
export function listCompanyNews(
  db: import("node:sqlite").DatabaseSync,
  companyName: string,
  limit = 10,
): NewsRow[] {
  return db
    .prepare("SELECT * FROM company_news WHERE company_name = ? ORDER BY published_at DESC LIMIT ?")
    .all(companyName, limit) as NewsRow[];
}

// ============================================================================
// skip_patterns CRUD
// ============================================================================

/** Check whether an email address matches any skip pattern. */
export function matchSkipPatterns(db: import("node:sqlite").DatabaseSync, email: string): boolean {
  const patterns = db.prepare("SELECT * FROM skip_patterns").all() as SkipPatternRow[];

  for (const p of patterns) {
    if (p.pattern_type === "domain") {
      const domain = email.split("@")[1]?.toLowerCase();
      if (domain && domain === p.pattern.toLowerCase()) {
        // bump hit count (best-effort; ignore errors)
        try {
          db.prepare("UPDATE skip_patterns SET hit_count = hit_count + 1 WHERE id = ?").run(p.id);
        } catch {
          // ignore
        }
        return true;
      }
    } else if (p.pattern_type === "keyword") {
      if (email.toLowerCase().includes(p.pattern.toLowerCase())) {
        try {
          db.prepare("UPDATE skip_patterns SET hit_count = hit_count + 1 WHERE id = ?").run(p.id);
        } catch {
          // ignore
        }
        return true;
      }
    } else if (p.pattern_type === "regex") {
      try {
        if (new RegExp(p.pattern, "i").test(email)) {
          db.prepare("UPDATE skip_patterns SET hit_count = hit_count + 1 WHERE id = ?").run(p.id);
          return true;
        }
      } catch {
        // invalid regex — skip this pattern
      }
    }
  }
  return false;
}

/** Insert a new skip pattern. Ignores duplicates. */
export function insertSkipPattern(
  db: import("node:sqlite").DatabaseSync,
  pattern: string,
  type: "domain" | "regex" | "keyword",
): void {
  db.prepare(`
    INSERT INTO skip_patterns (pattern, pattern_type, hit_count, created_at)
    VALUES (?, ?, 0, ?)
    ON CONFLICT(pattern) DO NOTHING
  `).run(pattern, type, Date.now());
}

/** List all skip patterns. */
export function listSkipPatterns(db: import("node:sqlite").DatabaseSync): SkipPatternRow[] {
  return db
    .prepare("SELECT * FROM skip_patterns ORDER BY hit_count DESC")
    .all() as SkipPatternRow[];
}

// ============================================================================
// discovery_decisions CRUD
// ============================================================================

/** Record an approve or reject decision for a candidate email. */
export function insertDiscoveryDecision(
  db: import("node:sqlite").DatabaseSync,
  email: string,
  decision: "approve" | "reject",
): void {
  db.prepare("INSERT INTO discovery_decisions (email, decision, created_at) VALUES (?, ?, ?)").run(
    email,
    decision,
    Date.now(),
  );
}

/** Total number of decisions made so far. */
export function countDecisions(db: import("node:sqlite").DatabaseSync): number {
  const row = db.prepare("SELECT COUNT(*) as count FROM discovery_decisions").get() as {
    count: number;
  };
  return row.count;
}

/** Returns true when the system has enough data to suggest auto-add mode:
 *  >= 50 decisions and reject rate < 20%. */
export function suggestAutoMode(db: import("node:sqlite").DatabaseSync): boolean {
  const total = countDecisions(db);
  if (total < 50) {
    return false;
  }
  const rejectRow = db
    .prepare("SELECT COUNT(*) as count FROM discovery_decisions WHERE decision = 'reject'")
    .get() as { count: number };
  return rejectRow.count / total < 0.2;
}
