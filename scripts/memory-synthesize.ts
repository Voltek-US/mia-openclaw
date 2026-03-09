#!/usr/bin/env bun
/**
 * memory-synthesize.ts — weekly synthesis of daily notes into the learnings DB
 *
 * Reads memory/YYYY-MM-DD.md files from the past N days (default: 7),
 * calls the LLM to extract durable preferences, patterns, and mistakes,
 * and writes each extracted item into the learnings SQLite database
 * (same DB used by learnings_record / learnings_query agent tools).
 *
 * Usage:
 *   bun scripts/memory-synthesize.ts [options]
 *
 * Options:
 *   --workspace <path>   Agent workspace directory (default: resolves via env)
 *   --sessions <path>    Sessions directory for learnings DB (default: resolves via env)
 *   --days <n>           Number of past days to read (default: 7)
 *   --dry-run            Print extracted items without writing to DB
 *   --verbose            Print progress information
 */

import fs from "node:fs";
import { createRequire } from "node:module";
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
const sessionsOverride = argValue("--sessions");

function log(...parts: unknown[]): void {
  if (verbose) {
    console.log("[memory-synthesize]", ...parts);
  }
}

// ---------------------------------------------------------------------------
// Path resolution (mirrors src/config/paths.ts + src/agents/agent-scope.ts)
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

function resolveDefaultSessionsDir(): string {
  return path.join(resolveStateDir(), "agents", "main", "sessions");
}

// ---------------------------------------------------------------------------
// SQLite shim (same bun:sqlite → node:sqlite pattern as log-ingest.ts)
// ---------------------------------------------------------------------------

type SqliteDB = {
  exec(sql: string): void;
  prepare(sql: string): { run(...args: unknown[]): { changes: number } };
  close(): void;
};

function openSqlite(dbPath: string): SqliteDB {
  const require = createRequire(import.meta.url);

  if (typeof Bun !== "undefined") {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { Database } = require("bun:sqlite");
      return new Database(dbPath) as SqliteDB;
    } catch {
      // fall through to node:sqlite
    }
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { DatabaseSync } = require("node:sqlite");
    return new DatabaseSync(dbPath) as SqliteDB;
  } catch {
    throw new Error(
      "Neither bun:sqlite nor node:sqlite is available. " +
        "Run this script with Bun or Node ≥ 22.5.",
    );
  }
}

// ---------------------------------------------------------------------------
// Learnings DB schema (minimal — mirrors learnings-store-sqlite.ts)
// ---------------------------------------------------------------------------

function ensureSchema(db: SqliteDB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS learnings (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      category   TEXT    NOT NULL,
      content    TEXT    NOT NULL,
      source     TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_learnings_category   ON learnings(category);
    CREATE INDEX IF NOT EXISTS idx_learnings_created_at ON learnings(created_at);
    INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('schema_version', '1');
  `);
}

function insertLearning(db: SqliteDB, category: string, content: string, source: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO learnings (category, content, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(category, content, source, now, now);
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

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - dayCount);

  for (let i = 0; i < dayCount; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10); // YYYY-MM-DD
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

type SynthesisItem = {
  category: "preference" | "pattern" | "mistake";
  content: string;
};

async function callLlm(prompt: string): Promise<string> {
  // Dynamic import so the script works without the full repo being built.
  const repoRoot = path.resolve(fileURLToPath(import.meta.url), "../../");
  const { runLlm } = await import(path.join(repoRoot, "shared/llm-router.js"));
  const { text } = await runLlm(prompt, {
    model: "claude-sonnet-4-6",
    caller: "memory-synthesize",
  });
  return text as string;
}

function buildPrompt(notes: Array<{ date: string; text: string }>): string {
  const combined = notes.map(({ date, text }) => `## ${date}\n\n${text}`).join("\n\n---\n\n");

  return `You are reading an agent's daily memory notes from the past week.
Extract durable items worth preserving in long-term memory.

Return ONLY a JSON array. Each item must have:
- "category": one of "preference", "pattern", or "mistake"
- "content": a concise, self-contained statement (1–2 sentences max)

Rules:
- "preference": stable user or workflow preferences discovered
- "pattern": recurring situations or requests that repeat across sessions
- "mistake": errors made, corrections received, things to avoid repeating
- Skip one-off tasks or transient events with no long-term value
- Skip anything already obvious or generic
- Return [] if nothing durable is found

Daily notes:
${combined}

JSON array:`;
}

function parseItems(raw: string): SynthesisItem[] {
  // Extract JSON array from LLM output (may have surrounding text)
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) {
    return [];
  }
  try {
    const parsed = JSON.parse(match[0]) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (item): item is SynthesisItem =>
        typeof item === "object" &&
        item !== null &&
        ["preference", "pattern", "mistake"].includes((item as SynthesisItem).category) &&
        typeof (item as SynthesisItem).content === "string" &&
        (item as SynthesisItem).content.trim().length > 0,
    );
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const workspaceDir = workspaceOverride ?? resolveDefaultWorkspaceDir();
  const sessionsDir = sessionsOverride ?? resolveDefaultSessionsDir();
  const dbPath = path.join(sessionsDir, "learnings.sqlite");

  log(`workspace: ${workspaceDir}`);
  log(`sessions:  ${sessionsDir}`);
  log(`db:        ${dbPath}`);
  log(`days:      ${days}`);

  // 1. Collect daily notes
  const notes = collectDailyNotes(workspaceDir, days);
  if (notes.length === 0) {
    log("No daily notes found — nothing to synthesize.");
    process.exit(0);
  }
  log(`Found ${notes.length} daily note file(s): ${notes.map((n) => n.date).join(", ")}`);

  // 2. Call LLM
  const prompt = buildPrompt(notes);
  log("Calling LLM for synthesis...");
  let rawResponse: string;
  try {
    rawResponse = await callLlm(prompt);
  } catch (err) {
    console.error("[memory-synthesize] LLM call failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  }

  // 3. Parse items
  const items = parseItems(rawResponse);
  if (items.length === 0) {
    log("LLM returned no durable items — done.");
    process.exit(0);
  }

  log(`Extracted ${items.length} item(s):`);
  for (const item of items) {
    log(`  [${item.category}] ${item.content}`);
  }

  // 4. Dry run: print and exit
  if (dryRun) {
    console.log("\n--- DRY RUN: extracted items (not written to DB) ---");
    for (const item of items) {
      console.log(`[${item.category}] ${item.content}`);
    }
    process.exit(0);
  }

  // 5. Write to learnings DB
  fs.mkdirSync(sessionsDir, { recursive: true });
  const db = openSqlite(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  ensureSchema(db);

  const source = `synthesis:${new Date().toISOString().slice(0, 10)}`;
  for (const item of items) {
    insertLearning(db, item.category, item.content, source);
  }
  db.close();

  log(`Wrote ${items.length} item(s) to ${dbPath}`);
}

main().catch((err) => {
  console.error("[memory-synthesize] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
