/**
 * Lock file management for the ingestion pipeline.
 * Prevents concurrent ingestions; automatically clears stale locks
 * when the owning process is no longer alive.
 */
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getKbDir } from "./db.ts";

const LOCK_FILE = () => join(getKbDir(), "ingest.lock");

interface LockData {
  pid: number;
  startedAt: number; // unix ms
  url?: string;
}

/** Returns true if process with given PID is alive. */
function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 checks existence without sending a signal.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Acquire the ingest lock.
 * @returns true if acquired, false if another live process holds it.
 */
export function acquireLock(url?: string): boolean {
  const lockPath = LOCK_FILE();

  if (existsSync(lockPath)) {
    let data: LockData | null = null;
    try {
      data = JSON.parse(readFileSync(lockPath, "utf8"));
    } catch {
      // Corrupted lock file — treat as stale.
    }

    if (data && isProcessAlive(data.pid)) {
      console.error(
        `[kb] Ingestion already in progress (PID ${data.pid}, started ${new Date(data.startedAt).toISOString()}, url=${data.url ?? "unknown"}). ` +
          `If this is stale, delete: ${lockPath}`,
      );
      return false;
    }

    // Stale lock — remove it.
    console.warn(`[kb] Removing stale lock from dead process (PID ${data?.pid ?? "unknown"}).`);
    releaseLock();
  }

  const lockData: LockData = { pid: process.pid, startedAt: Date.now(), url };
  writeFileSync(lockPath, JSON.stringify(lockData), "utf8");
  return true;
}

/** Release the ingest lock (only if we own it). */
export function releaseLock(): void {
  const lockPath = LOCK_FILE();
  if (!existsSync(lockPath)) {
    return;
  }

  try {
    const data: LockData = JSON.parse(readFileSync(lockPath, "utf8"));
    if (data.pid === process.pid) {
      rmSync(lockPath);
    }
    // Don't delete a lock owned by another live process.
  } catch {
    rmSync(lockPath, { force: true });
  }
}

/** Wrap an async function with lock acquire/release. */
export async function withLock<T>(url: string, fn: () => Promise<T>): Promise<T> {
  if (!acquireLock(url)) {
    throw new Error("Could not acquire ingest lock — another ingestion is running.");
  }
  try {
    return await fn();
  } finally {
    releaseLock();
  }
}
