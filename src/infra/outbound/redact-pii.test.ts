import { describe, expect, it } from "vitest";
import { FREEMAIL_DOMAINS, isFreemailDomain, redactPii } from "./redact-pii.js";

describe("isFreemailDomain", () => {
  it("identifies common freemail providers", () => {
    for (const domain of [
      "gmail.com",
      "yahoo.com",
      "hotmail.com",
      "outlook.com",
      "icloud.com",
      "proton.me",
    ]) {
      expect(isFreemailDomain(domain), domain).toBe(true);
    }
  });

  it("is case-insensitive", () => {
    expect(isFreemailDomain("Gmail.COM")).toBe(true);
  });

  it("passes through work/unknown domains", () => {
    for (const domain of ["acmecorp.com", "company.io", "example.org", "law.edu"]) {
      expect(isFreemailDomain(domain), domain).toBe(false);
    }
  });

  it("FREEMAIL_DOMAINS set is non-empty", () => {
    expect(FREEMAIL_DOMAINS.size).toBeGreaterThan(0);
  });
});

describe("redactPii - email addresses", () => {
  it("redacts personal email addresses", () => {
    expect(redactPii("Contact me at user@gmail.com for details.")).toBe(
      "Contact me at [email redacted] for details.",
    );
  });

  it("redacts multiple personal emails in one string", () => {
    const result = redactPii("From: alice@yahoo.com, To: bob@hotmail.com");
    expect(result).toBe("From: [email redacted], To: [email redacted]");
  });

  it("passes through work-domain emails", () => {
    const text = "Reach the team at support@acmecorp.com or ops@company.io";
    expect(redactPii(text)).toBe(text);
  });

  it("redacts personal but keeps work email in the same string", () => {
    const result = redactPii("personal: jane@gmail.com, work: jane@company.com");
    expect(result).toBe("personal: [email redacted], work: jane@company.com");
  });
});

describe("redactPii - phone numbers", () => {
  it("redacts US phone with dashes", () => {
    expect(redactPii("Call 800-555-1234 now.")).toBe("Call [phone redacted] now.");
  });

  it("redacts US phone with dots", () => {
    expect(redactPii("Call 800.555.1234 now.")).toBe("Call [phone redacted] now.");
  });

  it("redacts US phone with country code", () => {
    expect(redactPii("Call +1-800-555-1234 now.")).toBe("Call [phone redacted] now.");
  });

  it("does not redact partial digit sequences", () => {
    // A 6-digit sequence should not be treated as a phone number
    const text = "Order #123456 confirmed.";
    expect(redactPii(text)).toBe(text);
  });
});

describe("redactPii - dollar amounts", () => {
  it("redacts plain dollar amounts", () => {
    expect(redactPii("The deal is worth $500,000.")).toBe("The deal is worth [amount redacted].");
  });

  it("redacts shorthand dollar amounts", () => {
    expect(redactPii("Revenue hit $2M last quarter.")).toBe(
      "Revenue hit [amount redacted] last quarter.",
    );
  });

  it("redacts decimal dollar amounts", () => {
    expect(redactPii("Price: $9.99")).toBe("Price: [amount redacted]");
  });
});

describe("redactPii - clean and mixed text", () => {
  it("returns unchanged text when no PII present", () => {
    const text = "The weather is sunny today. Let me know if you need anything!";
    expect(redactPii(text)).toBe(text);
  });

  it("redacts only the PII portions in mixed text", () => {
    const result = redactPii(
      "Hi Bob, email me at bob@gmail.com or call 555-867-5309. Budget is $50,000.",
    );
    expect(result).toBe(
      "Hi Bob, email me at [email redacted] or call [phone redacted]. Budget is [amount redacted].",
    );
  });

  it("handles empty string", () => {
    expect(redactPii("")).toBe("");
  });
});
