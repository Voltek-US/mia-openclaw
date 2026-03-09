#!/usr/bin/env bun
/**
 * crm-discover.ts — interactive contact discovery and approval
 *
 * Scans recent email/calendar activity for new contacts and presents
 * them for interactive approval: (a)pprove / (r)eject / (s)kip-domain / (q)uit.
 *
 * Usage:
 *   bun scripts/crm-discover.ts [options]
 *
 * Options:
 *   --dry-run      Show candidates without writing to DB
 *   --verbose      Print progress
 *   --since <ISO>  Override lookback window (default: 7 days)
 *   --provider <p> gmail | ms365 | auto
 */

const args = process.argv.slice(2);

function argValue(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : undefined;
}

const dryRun = args.includes("--dry-run");
const verbose = args.includes("--verbose");
const sinceArg = argValue("--since");
const providerArg = (argValue("--provider") ?? process.env.CRM_PROVIDER ?? "auto") as
  | "gmail"
  | "ms365"
  | "auto";

function log(...parts: unknown[]): void {
  if (verbose) {
    console.log("[crm-discover]", ...parts);
  }
}

async function main(): Promise<void> {
  const since = sinceArg ? new Date(sinceArg) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  log(`Scanning since ${since.toISOString()} (provider: ${providerArg})`);

  const { openCrmDb } = await import("../src/intelligence/crm/crm-store.js");
  const { discoverCandidates, runInteractiveApproval } =
    await import("../src/intelligence/crm/crm-discover.js");

  const db = openCrmDb();
  if (!db) {
    console.error("[crm-discover] SQLite unavailable.");
    process.exit(1);
  }

  // Resolve providers
  type AnyEmailProvider = import("../src/intelligence/crm/crm-provider.js").EmailProvider | null;
  type AnyCalProvider = import("../src/intelligence/crm/crm-provider.js").CalendarProvider | null;

  let emailProvider: AnyEmailProvider = null;
  let calProvider: AnyCalProvider = null;

  if (providerArg === "gmail" || providerArg === "auto") {
    const { loadGmailOAuthClient, createGmailProvider } =
      await import("../src/intelligence/crm/crm-gmail.js");
    const { createGoogleCalendarProvider } =
      await import("../src/intelligence/crm/crm-calendar-google.js");
    const auth = loadGmailOAuthClient();
    if (auth) {
      emailProvider = createGmailProvider(auth);
      calProvider = createGoogleCalendarProvider(auth);
      log("Gmail provider loaded");
    }
  }

  if (!emailProvider && (providerArg === "ms365" || providerArg === "auto")) {
    const { createMs365Provider } = await import("../src/intelligence/crm/crm-msgraph.js");
    const { createMs365CalendarProvider } =
      await import("../src/intelligence/crm/crm-calendar-ms365.js");
    const provider = createMs365Provider();
    if (provider) {
      emailProvider = provider;
      calProvider = createMs365CalendarProvider() ?? null;
      log("MS365 provider loaded");
    }
  }

  if (!emailProvider || !calProvider) {
    console.error(
      "[crm-discover] No provider available.\n" +
        "  Run `openclaw crm auth-gmail` or `openclaw crm auth-ms365` first.",
    );
    process.exit(1);
  }

  console.log("[crm-discover] Scanning for new contacts...");
  const candidates = await discoverCandidates(db, emailProvider, calProvider, since);
  console.log(`[crm-discover] Found ${candidates.length} candidates after filtering.\n`);

  if (candidates.length === 0) {
    console.log("[crm-discover] Nothing new to review.");
    return;
  }

  if (dryRun) {
    console.log("Candidates (dry-run, not saved):");
    for (const c of candidates) {
      console.log(`  ${c.email}${c.name ? ` (${c.name})` : ""} — ${c.source}`);
    }
    return;
  }

  const { approved, rejected, skipped } = await runInteractiveApproval(db, candidates);
  console.log(
    `\n[crm-discover] Done. Approved: ${approved}, Rejected: ${rejected}, Skipped: ${skipped}`,
  );
}

main().catch((err) => {
  console.error("[crm-discover] Fatal:", err);
  process.exit(1);
});
