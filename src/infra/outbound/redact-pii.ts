/**
 * Outbound PII redaction — safety net for personal data in agent replies.
 *
 * Acts as a last-resort filter after agent-level data-classification rules.
 * Redacts personal email addresses, phone numbers, and dollar amounts.
 * Work-domain emails and non-personal content pass through unchanged.
 *
 * @see docs/reference/templates/AGENTS.md — Data Classification section
 */

/**
 * Common freemail providers whose addresses are treated as personal (Confidential tier).
 * Work-domain addresses are not in this list and pass through unredacted.
 */
export const FREEMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.co.uk",
  "hotmail.com",
  "hotmail.co.uk",
  "outlook.com",
  "live.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "aol.com",
  "zoho.com",
  "yandex.com",
  "yandex.ru",
  "mail.com",
  "gmx.com",
  "gmx.net",
]);

// Matches email-like tokens; caller decides whether the domain is personal.
const EMAIL_RE = /\b([\w.%+-]+)@([\w-]+(?:\.[\w-]+)+)\b/gi;

// Common phone formats: +1 (800) 555-1234, 800-555-1234, 8005551234, +447911123456, etc.
const PHONE_RE = /(?<!\d)(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]\d{4}(?!\d)/g;

// Dollar amounts: $1,200 / $5.99 / $2M / $500 million / $1.5B
const DOLLAR_RE = /\$\s?\d[\d,]*(?:\.\d{1,2})?(?:\s*(?:[KMBkmb]|million|billion|thousand))?/g;

/**
 * Returns true when the given email domain is a known personal/freemail provider.
 * Conservative: unknown domains are assumed to be work domains and pass through.
 */
export function isFreemailDomain(domain: string): boolean {
  return FREEMAIL_DOMAINS.has(domain.toLowerCase());
}

/**
 * Redact personal PII from `text` before it leaves the outbound pipeline.
 *
 * - Personal (freemail) email addresses → `[email redacted]`
 * - Phone numbers (common formats) → `[phone redacted]`
 * - Dollar amounts → `[amount redacted]`
 * - Work-domain emails, non-PII content → unchanged
 */
export function redactPii(text: string): string {
  // Redact freemail addresses; keep work-domain emails.
  const withEmails = text.replace(EMAIL_RE, (_match, _local, domain: string) => {
    return isFreemailDomain(domain) ? "[email redacted]" : _match;
  });

  // Redact phone numbers.
  const withPhones = withEmails.replace(PHONE_RE, "[phone redacted]");

  // Redact dollar amounts.
  return withPhones.replace(DOLLAR_RE, "[amount redacted]");
}
