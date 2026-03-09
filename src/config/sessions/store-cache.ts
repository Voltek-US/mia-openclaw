import type { SessionEntry } from "./types.js";

// When SQLite is the source of truth, a short in-process TTL is used instead
// of the file-based 45-second TTL. Cross-process reads are always fresh from
// the DB; this cache only reduces structuredClone overhead within a process.
export const SQLITE_SESSION_CACHE_TTL_MS = 5_000;

type SessionStoreCacheEntry = {
  store: Record<string, SessionEntry>;
  loadedAt: number;
  storePath: string;
  // For JSON path only:
  mtimeMs?: number;
  sizeBytes?: number;
  serialized?: string;
};

const SESSION_STORE_CACHE = new Map<string, SessionStoreCacheEntry>();
const SESSION_STORE_SERIALIZED_CACHE = new Map<string, string>();

export function clearSessionStoreCaches(): void {
  SESSION_STORE_CACHE.clear();
  SESSION_STORE_SERIALIZED_CACHE.clear();
}

export function invalidateSessionStoreCache(storePath: string): void {
  SESSION_STORE_CACHE.delete(storePath);
  SESSION_STORE_SERIALIZED_CACHE.delete(storePath);
}

export function getSerializedSessionStore(storePath: string): string | undefined {
  return SESSION_STORE_SERIALIZED_CACHE.get(storePath);
}

export function setSerializedSessionStore(storePath: string, serialized?: string): void {
  if (serialized === undefined) {
    SESSION_STORE_SERIALIZED_CACHE.delete(storePath);
    return;
  }
  SESSION_STORE_SERIALIZED_CACHE.set(storePath, serialized);
}

export function dropSessionStoreObjectCache(storePath: string): void {
  SESSION_STORE_CACHE.delete(storePath);
}

export function readSessionStoreCache(params: {
  storePath: string;
  ttlMs: number;
  mtimeMs?: number;
  sizeBytes?: number;
}): Record<string, SessionEntry> | null {
  const cached = SESSION_STORE_CACHE.get(params.storePath);
  if (!cached) {
    return null;
  }
  const now = Date.now();
  if (now - cached.loadedAt > params.ttlMs) {
    invalidateSessionStoreCache(params.storePath);
    return null;
  }
  // For the JSON path, also invalidate on mtime/size changes.
  if (
    params.mtimeMs !== undefined &&
    (params.mtimeMs !== cached.mtimeMs || params.sizeBytes !== cached.sizeBytes)
  ) {
    invalidateSessionStoreCache(params.storePath);
    return null;
  }
  return structuredClone(cached.store);
}

export function writeSessionStoreCache(params: {
  storePath: string;
  store: Record<string, SessionEntry>;
  mtimeMs?: number;
  sizeBytes?: number;
  serialized?: string;
}): void {
  SESSION_STORE_CACHE.set(params.storePath, {
    store: structuredClone(params.store),
    loadedAt: Date.now(),
    storePath: params.storePath,
    mtimeMs: params.mtimeMs,
    sizeBytes: params.sizeBytes,
    serialized: params.serialized,
  });
  if (params.serialized !== undefined) {
    SESSION_STORE_SERIALIZED_CACHE.set(params.storePath, params.serialized);
  }
}
