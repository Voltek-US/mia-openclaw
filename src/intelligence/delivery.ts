import { execSync } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import { queryExpertAnalyses, queryRecommendations } from "./bi-store.js";

// ============================================================================
// Digest formatting
// ============================================================================

/** Build the nightly digest text for the given run. */
export function formatDigest(runId: string, db: DatabaseSync): string {
  const date = new Date().toISOString().slice(0, 10);
  const analyses = queryExpertAnalyses(db, { runId });
  const recs = queryRecommendations(db, { runId });

  const lines: string[] = [];
  lines.push(`*BI Council — ${date}*`);
  lines.push("");

  // Expert highlights — extract the FINDING line from each analysis.
  lines.push("*Expert Highlights*");
  if (analyses.length === 0) {
    lines.push("• No expert analyses for this run.");
  } else {
    for (const a of analyses) {
      const finding = extractFinding(a.analysis_text);
      lines.push(`• ${a.expert_name}: ${finding}`);
    }
  }
  lines.push("");

  // Ranked recommendations.
  lines.push("*Top Recommendations*");
  if (recs.length === 0) {
    lines.push("No recommendations generated for this run.");
  } else {
    for (const rec of recs) {
      const priorityLabel = rec.priority.toUpperCase();
      let domains: string[] = [];
      try {
        domains = JSON.parse(rec.contributing_domains) as string[];
      } catch {
        // ignore malformed JSON
      }
      const domainStr = domains.length > 0 ? ` (domains: ${domains.join(", ")})` : "";
      lines.push(`${rec.rank}. [${priorityLabel}] ${rec.title} — ${rec.rationale}${domainStr}`);
    }
  }
  lines.push("");
  lines.push("Use `openclaw council recommendations` for full analysis.");
  lines.push("Use `openclaw council feedback <id> accept` to act on a recommendation.");

  return lines.join("\n");
}

/** Extract the FINDING line from expert analysis text. Falls back to first line. */
function extractFinding(text: string): string {
  const match = /^FINDING:\s*(.+)$/m.exec(text);
  if (match) {
    return match[1].trim();
  }
  // Fallback: return first non-empty line truncated.
  const firstLine = text.split("\n").find((l) => l.trim().length > 0) ?? text;
  return firstLine.slice(0, 120);
}

// ============================================================================
// Delivery
// ============================================================================

/** Send the digest text to a channel via `openclaw message send`. */
export function sendDigest(text: string, channel: string): void {
  execSync(
    `openclaw message send --to ${JSON.stringify(channel)} --message ${JSON.stringify(text)}`,
    { stdio: "inherit" },
  );
}

/** Send an error alert to the channel when the council run fails. */
export function sendErrorAlert(channel: string, message: string): void {
  const text = `*BI Council — Run Failed*\n\n${message}`;
  try {
    execSync(
      `openclaw message send --to ${JSON.stringify(channel)} --message ${JSON.stringify(text)}`,
      { stdio: "inherit" },
    );
  } catch {
    // Don't throw if the error alert itself fails; just log.
    console.error("[council] Failed to send error alert:", message);
  }
}
