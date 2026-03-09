/**
 * prompt-sync-check.ts
 *
 * Nightly sync review for the dual prompt stacks (prompts/claude/ and prompts/openai/).
 * Checks:
 *   1. File coverage — every file in one stack must have a counterpart in the other.
 *   2. Fact drift — operational atoms (IDs, paths, commands, tier names, schedules,
 *      model IDs) must be present in both stacks.
 *
 * Exit codes:
 *   0 = clean
 *   1 = discrepancies found
 *
 * Env vars:
 *   PROMPT_SYNC_CHANNEL — if set, sends a summary message to that channel via
 *                         `openclaw message send` when discrepancies are found.
 */

import { execSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

const CLAUDE_DIR = join(REPO_ROOT, "prompts", "claude");
const OPENAI_DIR = join(REPO_ROOT, "prompts", "openai");

// ---------------------------------------------------------------------------
// Fact extraction patterns
// These patterns extract "operational atoms" from prompt files that must be
// present in both stacks to ensure they stay in sync.
// ---------------------------------------------------------------------------

const FACT_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  // Numeric IDs (channel IDs, project IDs, port numbers)
  { name: "numeric-id", pattern: /\b\d{4,}\b/g },
  // Absolute paths (exclude trailing markdown/XML punctuation and HTML entities)
  { name: "abs-path", pattern: /(?:~\/|\/(?:home|tmp|var|usr|etc))[^\s"'<>&\]})`,;]+/g },
  // Data classification tier names — case-insensitive so ALL-CAPS (GPT stack) matches
  // title-case (Claude stack). "External" is excluded because it was renamed to "Restricted".
  {
    name: "tier-name",
    pattern: /\b(Confidential|Internal|Restricted)\b/gi,
  },
  // Cron schedule patterns (cron expressions or English schedules)
  {
    name: "cron-schedule",
    pattern: /\d{1,2}:\d{2}\s*(?:AM|PM)|[0-9*]{1,2}\s+[0-9*]{1,2}\s+[0-9*]\s+[0-9*]\s+[0-9*]/g,
  },
  // Claude model IDs
  { name: "model-id", pattern: /\bclaude-(?:opus|sonnet|haiku)-[\d.-]+\b/gi },
  // GPT model IDs
  { name: "model-id-gpt", pattern: /\bgpt-[\w.-]+\b/gi },
  // Key env var names (all-caps identifiers ending in _KEY, _ID, _TOKEN, _CHANNEL)
  {
    name: "env-var",
    pattern: /\b[A-Z][A-Z0-9_]+(?:_KEY|_ID|_TOKEN|_CHANNEL|_DB|_LOG)\b/g,
  },
  // Shell commands — normalized to "openclaw <subcommand>" (first two tokens only) so that
  // differences in flags/args between prose and code-block forms don't generate false drift.
  {
    name: "openclaw-cmd",
    pattern: /openclaw[ \t]+(channels|config|message|gateway|agent|doctor|login)\b/g,
  },
  // Repo-relative file paths mentioned explicitly
  {
    name: "repo-path",
    pattern: /\b(?:shared|src|scripts|docs|prompts)\/[\w./-]+\.[a-z]{2,4}\b/g,
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function listFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
}

function readFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** Extract all fact atoms from a file using the defined patterns. */
function extractFacts(content: string): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const { name, pattern } of FACT_PATTERNS) {
    const matches = [...content.matchAll(pattern)].map((m) => m[0].trim().toLowerCase());
    if (matches.length > 0) {
      result.set(name, new Set(matches));
    }
  }
  return result;
}

/** Set difference: items in a that are not in b. */
function setDiff<T>(a: Set<T>, b: Set<T>): Set<T> {
  return new Set([...a].filter((x) => !b.has(x)));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface Discrepancy {
  file: string;
  kind: "missing-in-claude" | "missing-in-openai" | "fact-drift";
  detail: string;
}

async function main(): Promise<void> {
  const discrepancies: Discrepancy[] = [];

  const claudeFiles = new Set(listFiles(CLAUDE_DIR));
  const openaiFiles = new Set(listFiles(OPENAI_DIR));

  // 1. Coverage check
  for (const f of claudeFiles) {
    if (!openaiFiles.has(f)) {
      discrepancies.push({
        file: f,
        kind: "missing-in-openai",
        detail: `prompts/claude/${f} has no counterpart in prompts/openai/`,
      });
    }
  }
  for (const f of openaiFiles) {
    if (!claudeFiles.has(f)) {
      discrepancies.push({
        file: f,
        kind: "missing-in-claude",
        detail: `prompts/openai/${f} has no counterpart in prompts/claude/`,
      });
    }
  }

  // 2. Fact drift check for files present in both stacks
  const sharedFiles = [...claudeFiles].filter((f) => openaiFiles.has(f));
  for (const f of sharedFiles) {
    const claudeContent = readFile(join(CLAUDE_DIR, f));
    const openaiContent = readFile(join(OPENAI_DIR, f));

    const claudeFacts = extractFacts(claudeContent);
    const openaiFacts = extractFacts(openaiContent);

    // Collect all fact categories from both sides
    const categories = new Set([...claudeFacts.keys(), ...openaiFacts.keys()]);

    for (const category of categories) {
      const cSet = claudeFacts.get(category) ?? new Set<string>();
      const oSet = openaiFacts.get(category) ?? new Set<string>();

      const onlyInClaude = setDiff(cSet, oSet);
      const onlyInOpenai = setDiff(oSet, cSet);

      // Only report numeric-id and env-var drift if they differ by more than 1 item
      // to reduce noise from incidental number matches.
      const threshold = category === "numeric-id" || category === "env-var" ? 2 : 1;

      if (onlyInClaude.size >= threshold) {
        discrepancies.push({
          file: f,
          kind: "fact-drift",
          detail: `[${category}] present in claude/ but missing in openai/: ${[...onlyInClaude].slice(0, 5).join(", ")}`,
        });
      }
      if (onlyInOpenai.size >= threshold) {
        discrepancies.push({
          file: f,
          kind: "fact-drift",
          detail: `[${category}] present in openai/ but missing in claude/: ${[...onlyInOpenai].slice(0, 5).join(", ")}`,
        });
      }
    }
  }

  // 3. Report
  const timestamp = new Date().toISOString();

  if (discrepancies.length === 0) {
    console.log(`[${timestamp}] prompt-sync-check: OK — no discrepancies found.`);
    process.exit(0);
  }

  const lines = [
    `prompt-sync-check: ${discrepancies.length} discrepancy(ies) found at ${timestamp}`,
    "",
    ...discrepancies.map((d, i) => `${i + 1}. [${d.kind}] ${d.file}: ${d.detail}`),
    "",
    "Run `bun scripts/prompt-sync-check.ts` locally to reproduce.",
    "Update both stacks so operational facts match, then re-run.",
  ];

  const report = lines.join("\n");
  console.error(report);

  // Optionally send to monitoring channel
  const channel = process.env["PROMPT_SYNC_CHANNEL"];
  if (channel) {
    try {
      execSync(
        `openclaw message send --channel ${JSON.stringify(channel)} --message ${JSON.stringify(report)}`,
        { stdio: "pipe" },
      );
    } catch (err) {
      console.error("Failed to send report to monitoring channel:", err);
    }
  }

  process.exit(1);
}

main().catch((err) => {
  console.error("prompt-sync-check: fatal error:", err);
  process.exit(1);
});
