#!/usr/bin/env bun
/**
 * Post-tool-use hook — scans Claude Code tool results for error patterns
 * and records them into the learnings SQLite database.
 *
 * Registered in ~/.claude/settings.json as a PostToolUse hook.
 * Receives a JSON event on stdin:
 *   { tool_name, tool_input, tool_response: { output, error, ... } }
 *
 * Silently exits 0 on any failure — hooks must never block tool execution.
 */

import os from "node:os";
import path from "node:path";

// Patterns that indicate errors worth tracking.
const ERROR_SIGNATURES: RegExp[] = [
  /Error:\s+.{5,}/,
  /ENOENT|ECONNREFUSED|EACCES|ETIMEDOUT/,
  /TypeError|ReferenceError|SyntaxError/,
  /Cannot find module/,
  /command not found/,
  /\b(403|401|404|500|502|503)\b.*?(error|failed|denied)/i,
  /timeout.*?(ms|seconds|expired)/i,
  /npm ERR!|pnpm ERR!/,
  /ExperimentalWarning.*sqlite/i,
];

function extractErrorPattern(text: string): string | null {
  for (const re of ERROR_SIGNATURES) {
    const match = text.match(re);
    if (match) {
      // Normalize: collapse whitespace and truncate to 120 chars for dedup.
      return match[0].replace(/\s+/g, " ").trim().slice(0, 120);
    }
  }
  return null;
}

function resolveAgentSessionsDir(): string {
  const home = process.env.OPENCLAW_HOME ?? path.join(os.homedir(), ".openclaw");
  return path.join(home, "agents", "main", "sessions");
}

async function main() {
  // Read stdin.
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
  }
  if (!raw.trim()) {
    process.exit(0);
  }

  let event: { tool_name?: string; tool_response?: { output?: string; error?: string } };
  try {
    event = JSON.parse(raw) as typeof event;
  } catch {
    process.exit(0);
  }

  // Combine output and error fields into one blob to scan.
  const blob = [event.tool_response?.output ?? "", event.tool_response?.error ?? ""]
    .join("\n")
    .slice(0, 4000); // cap to avoid huge scans

  const pattern = extractErrorPattern(blob);
  if (!pattern) {
    process.exit(0);
  }

  // Record in learnings DB — import dynamically to avoid startup cost when no error.
  try {
    const { openLearningsDb, upsertErrorPattern } =
      await import("../../src/agents/tools/learnings-store-sqlite.js");
    const sessionsDir = resolveAgentSessionsDir();
    const db = openLearningsDb(sessionsDir);
    if (!db) {
      process.exit(0);
    }
    const toolName = event.tool_name ?? "unknown";
    upsertErrorPattern(db, { pattern, example: `[${toolName}] ${blob.slice(0, 200)}` });
  } catch {
    // Never surface hook errors to the user.
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
