// ============================================================================
// Provider abstraction
//
// Both Gmail and Microsoft 365 implement these interfaces.
// The discovery pipeline, daily cron, and draft system depend only on these
// interfaces — never on provider-specific implementations directly.
// ============================================================================

export type EmailAddress = {
  name?: string;
  email: string;
};

export type EmailMessage = {
  /** Provider-unique message ID — used as dedup key in interactions table. */
  messageId: string;
  /** Conversation/thread ID (optional — used for draft replies and fetch). */
  threadId?: string;
  from: EmailAddress;
  to: EmailAddress[];
  subject: string;
  /** Short preview snippet (not full body). */
  snippet: string;
  date: Date;
  /** True when the message has a List-Unsubscribe header (newsletter signal). */
  listUnsubscribe: boolean;
};

export type EmailThread = {
  threadId: string;
  messages: Array<{
    from: string;
    body: string;
    date: Date;
  }>;
};

export type DraftOptions = {
  to: string;
  subject: string;
  body: string;
  /** If set, the draft is a reply in this thread. */
  threadId?: string;
};

export type CalendarEvent = {
  /** Provider-unique event ID. */
  eventId: string;
  title: string;
  startTime: Date;
  endTime: Date;
  /** Email addresses of all attendees. */
  attendees: string[];
};

/** Email provider interface — implemented by Gmail and MS365 adapters. */
export interface EmailProvider {
  /** Fetch messages received since the given date. */
  fetchRecentMessages(since: Date, limit?: number): Promise<EmailMessage[]>;
  /** Fetch a full thread by its ID. */
  fetchThread(threadId: string): Promise<EmailThread>;
  /** Create a draft email. Returns the provider draft ID. */
  createDraft(opts: DraftOptions): Promise<string>;
}

/** Calendar provider interface — implemented by Google Calendar and MS365 Calendar adapters. */
export interface CalendarProvider {
  /** Fetch calendar events starting on or after the given date. */
  fetchRecentEvents(since: Date): Promise<CalendarEvent[]>;
}
