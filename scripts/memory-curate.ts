#!/usr/bin/env bun
/**
 * memory-curate.ts — twice-weekly rewrite of MEMORY.md
 *
 * Reads the 7 most recent daily notes (memory/YYYY-MM-DD.md) and the current
 * MEMORY.md, calls the LLM to identify stale info and new durable facts, then
 * rewrites MEMORY.md in-place (max 400 lines), updating the last-curated date.
 *
 * Distinct from scripts/memory-synthesize.ts, which writes to the learnings
 * SQLite DB. This script rewrites the human-readable MEMORY.md file itself.
 *
 * Intended cron schedule: "0 5 * * 3,0" (Wednesday and Sunday at 05:00)
 *
 * Usage:
 *   bun scripts/memory-curate.ts [options]
 *
 * Options:
 *   --workspace <path>   Agent workspace directory (default: resolves via env)
 *   --days <n>           Number of past daily notes to read (default: 7)
 *   --dry-run            Print the proposed new MEMORY.md without writing it
 *   --verbose            Print progress information
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

function argValue(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : undefined;
}

const dryRun = args.includes("--dry-run");
const verbose = args.includes("--verbose");
const days = parseInt(argValue("--days") ?? "7", 10);
const workspaceOverride = argValue("--workspace");

function log(...parts: unknown[]): void {
  if (verbose) {
    console.log("[memory-curate]", ...parts);
  }
}

// ---------------------------------------------------------------------------
// Path resolution (mirrors src/config/paths.ts)
// ---------------------------------------------------------------------------

function resolveStateDir(): string {
  const env = process.env["OPENCLAW_STATE_DIR"] ?? process.env["CLAWDBOT_STATE_DIR"];
  if (env) {
    return path.resolve(env.startsWith("~") ? env.replace("~", os.homedir()) : env);
  }
  return path.join(os.homedir(), ".openclaw");
}

function resolveDefaultWorkspaceDir(): string {
  return path.join(resolveStateDir(), "workspace");
}

// ---------------------------------------------------------------------------
// Collect daily note files
// ---------------------------------------------------------------------------

function collectDailyNotes(
  workspaceDir: string,
  dayCount: number,
): Array<{ date: string; text: string }> {
  const memoryDir = path.join(workspaceDir, "memory");
  const notes: Array<{ date: string; text: string }> = [];
  for (let i = 0; i < dayCount; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const filePath = path.join(memoryDir, `${dateStr}.md`);
    if (fs.existsSync(filePath)) {
      const text = fs.readFileSync(filePath, "utf8").trim();
      if (text) {
        notes.push({ date: dateStr, text });
      }
    }
  }
  return notes;
}

// ---------------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------------

async function callLlm(prompt: string): Promise<string> {
  const repoRoot = path.resolve(fileURLToPath(import.meta.url), "../../");
  const { runLlm } = await import(path.join(repoRoot, "shared/llm-router.js"));
  const { text } = await runLlm(prompt, {
    model: "claude-sonnet-4-6",
    caller: "memory-curate",
  });
  return text as string;
}

function buildPrompt(currentMemory: string, notes: Array<{ date: string; text: string }>): string {
  const combined = notes.map(({ date, text }) => `## ${date}\n\n${text}`).join("\n\n---\n\n");

  const today = new Date().toISOString().slice(0, 10);

  return `You are curating an AI agent's long-term MEMORY.md file.
Your job is to rewrite it to be accurate, current, and concise.

Rules:
- Keep the same section structure (## Memory System, ## Preferences, ## Patterns, ## Flagged, etc.)
- Update or remove stale stats, outdated project info, and resolved issues
- Add new durable facts from the daily notes (decisions, preferences, recurring patterns)
- Do NOT include one-off tasks or transient events
- Keep the file under 400 lines total
- Preserve the YAML front-matter (--- ... ---) at the top exactly as-is
- Add a comment "<!-- Last curated: ${today} -->" below the # MEMORY.md heading
- Return ONLY the complete new MEMORY.md content, nothing else

Current MEMORY.md:
---
${currentMemory}
---

Recent daily notes (past ${notes.length} days):
---
${combined}
---

New MEMORY.md content:`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const workspaceDir = workspaceOverride ?? resolveDefaultWorkspaceDir();
  const memoryMdPath = path.join(workspaceDir, "MEMORY.md");

  log(`workspace: ${workspaceDir}`);
  log(`days:      ${days}`);
  log(`dry-run:   ${dryRun}`);

  // 1. Read current MEMORY.md (create a minimal one if missing).
  let currentMemory = "";
  if (fs.existsSync(memoryMdPath)) {
    currentMemory = fs.readFileSync(memoryMdPath, "utf8").trim();
    log(`Read MEMORY.md (${currentMemory.length} chars)`);
  } else {
    log("MEMORY.md not found — will create it from scratch");
    currentMemory = "# MEMORY.md\n\n## Preferences\n\n## Patterns\n\n## Flagged\n";
  }

  // 2. Collect daily notes.
  const notes = collectDailyNotes(workspaceDir, days);
  if (notes.length === 0) {
    log("No daily notes found — nothing to curate from. Exiting.");
    process.exit(0);
  }
  log(`Found ${notes.length} daily note file(s): ${notes.map((n) => n.date).join(", ")}`);

  // 3. Call LLM.
  const prompt = buildPrompt(currentMemory, notes);
  log("Calling LLM for curation...");
  let newContent: string;
  try {
    newContent = await callLlm(prompt);
  } catch (err) {
    console.error("[memory-curate] LLM call failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  }

  newContent = newContent.trim();
  if (!newContent) {
    console.error("[memory-curate] LLM returned empty content — aborting.");
    process.exit(1);
  }

  // 4. Dry run: print and exit.
  if (dryRun) {
    console.log("\n--- DRY RUN: proposed new MEMORY.md ---");
    console.log(newContent);
    console.log("--- END DRY RUN ---");
    process.exit(0);
  }

  // 5. Write new MEMORY.md.
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(memoryMdPath, newContent + "\n", "utf8");
  log(`Wrote new MEMORY.md (${newContent.length} chars, ${newContent.split("\n").length} lines)`);

  console.log(`[memory-curate] Done. MEMORY.md updated from ${notes.length} daily notes.`);
}

main().catch((err) => {
  console.error("[memory-curate] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
