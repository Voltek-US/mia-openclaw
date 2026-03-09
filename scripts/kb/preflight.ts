/**
 * Preflight checks: validate KB paths, database integrity,
 * and stale lock files before any KB operation.
 */
import { existsSync, statSync, readFileSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { getKbDir, getDbPath } from "./db.ts";

export interface PreflightResult {
  ok: boolean;
  warnings: string[];
  errors: string[];
}

/**
 * Run all preflight checks.
 * @param requireDb - If true, also verify the database can be opened.
 */
export function runPreflight(requireDb = true): PreflightResult {
  const result: PreflightResult = { ok: true, warnings: [], errors: [] };

  const kbDir = getKbDir();
  const dbPath = getDbPath();

  // 1. KB directory must exist (or be creatable).
  if (!existsSync(kbDir)) {
    // Will be created on openDb(); just warn.
    result.warnings.push(
      `KB directory does not exist yet: ${kbDir} (will be created on first use).`,
    );
  } else {
    try {
      const stat = statSync(kbDir);
      if (!stat.isDirectory()) {
        result.errors.push(`KB path exists but is not a directory: ${kbDir}`);
        result.ok = false;
      }
    } catch (e) {
      result.errors.push(`Cannot stat KB directory: ${kbDir} — ${String(e)}`);
      result.ok = false;
    }
  }

  // 2. If the DB file exists, check it's readable and non-zero.
  if (existsSync(dbPath)) {
    try {
      const stat = statSync(dbPath);
      if (stat.size === 0) {
        result.warnings.push(`Knowledge database is empty (0 bytes): ${dbPath}`);
      }
    } catch (e) {
      result.errors.push(`Cannot stat knowledge database: ${dbPath} — ${String(e)}`);
      result.ok = false;
    }

    // 3. Quick SQLite magic-bytes sanity check (first 6 bytes = "SQLite").
    if (result.ok) {
      try {
        const buf = Buffer.alloc(16);
        const fd = openSync(dbPath, "r");
        readSync(fd, buf, 0, 16, 0);
        closeSync(fd);
        const magic = buf.slice(0, 6).toString("ascii");
        if (magic !== "SQLite") {
          result.errors.push(`Knowledge database appears corrupted (bad magic bytes): ${dbPath}`);
          result.ok = false;
        }
      } catch {
        // Non-fatal — let openDb() surface any real error.
      }
    }
  } else if (requireDb) {
    result.warnings.push(
      `Knowledge database not found: ${dbPath} (will be created on first ingest).`,
    );
  }

  // 4. Check for stale lock file.
  const lockPath = join(kbDir, "ingest.lock");
  if (existsSync(lockPath)) {
    try {
      const data = JSON.parse(readFileSync(lockPath, "utf8"));
      const pid: number = data.pid;
      let alive = false;
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {
        /* dead */
      }
      if (alive) {
        result.warnings.push(
          `Ingest lock held by live process PID=${pid} since ${new Date(data.startedAt).toISOString()}. ` +
            `URL: ${data.url ?? "unknown"}`,
        );
      } else {
        result.warnings.push(
          `Stale lock file found (PID=${pid} is dead). Run with --force or delete: ${lockPath}`,
        );
      }
    } catch {
      result.warnings.push(`Lock file exists but is unreadable: ${lockPath}`);
    }
  }

  return result;
}

/** Print preflight results and exit with code 1 if there are errors. */
export function assertPreflight(result: PreflightResult): void {
  for (const w of result.warnings) {
    console.warn(`[kb:preflight] WARN  ${w}`);
  }
  for (const e of result.errors) {
    console.error(`[kb:preflight] ERROR ${e}`);
  }
  if (!result.ok) {
    console.error("[kb:preflight] Aborting due to preflight errors.");
    process.exit(1);
  }
}
