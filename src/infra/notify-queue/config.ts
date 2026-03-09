import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { resolveRequiredHomeDir } from "../../infra/home-dir.js";
import type { NotifyTier } from "./store.js";

// ============================================================================
// Types
// ============================================================================

export interface NotifyClassifierRule {
  /** Match against the caller-supplied messageType (exact string). */
  type?: string;
  /** Match as substring or regex against the message text. */
  pattern?: string;
  tier: NotifyTier;
}

export interface NotifyQueueConfig {
  version: 1;
  /** Enable LLM fallback classification when no rule matches. Default: false. */
  llmFallback?: boolean;
  /** Tier to use when no rule matches and LLM is disabled. Default: "medium". */
  defaultTier?: NotifyTier;
  rules: NotifyClassifierRule[];
}

// ============================================================================
// Default config
// ============================================================================

export const DEFAULT_NOTIFY_CONFIG: NotifyQueueConfig = {
  version: 1,
  llmFallback: false,
  defaultTier: "medium",
  rules: [
    { type: "system-error", tier: "critical" },
    { type: "interactive-prompt", tier: "critical" },
    { pattern: "requires your input", tier: "critical" },
    { type: "job-failure", tier: "high" },
    { type: "job-success", tier: "medium" },
  ],
};

// ============================================================================
// Path helpers
// ============================================================================

export function resolveNotifyQueueConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = () => resolveRequiredHomeDir(env, os.homedir),
): string {
  return path.join(resolveStateDir(env, homedir), "notify-queue-config.json");
}

// ============================================================================
// Loader (with in-process cache)
// ============================================================================

let _cachedConfig: NotifyQueueConfig | null = null;
let _cachedConfigPath: string | null = null;

/** Load and cache the notify queue config. Falls back to defaults if missing or invalid. */
export function loadNotifyQueueConfig(env: NodeJS.ProcessEnv = process.env): NotifyQueueConfig {
  const configPath = resolveNotifyQueueConfigPath(env);

  // Invalidate cache when path changes (e.g. different env in tests).
  if (_cachedConfigPath !== configPath) {
    _cachedConfig = null;
    _cachedConfigPath = configPath;
  }
  if (_cachedConfig) {
    return _cachedConfig;
  }

  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const validated = validateConfig(parsed);
    _cachedConfig = validated;
    return validated;
  } catch {
    // Config file absent or malformed — use defaults silently.
    _cachedConfig = DEFAULT_NOTIFY_CONFIG;
    return DEFAULT_NOTIFY_CONFIG;
  }
}

/** Clear the in-process cache (used in tests). */
export function clearNotifyConfigCacheForTest(): void {
  _cachedConfig = null;
  _cachedConfigPath = null;
}

// ============================================================================
// Validation (minimal, no TypeBox dependency)
// ============================================================================

function validateConfig(raw: unknown): NotifyQueueConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return DEFAULT_NOTIFY_CONFIG;
  }
  const obj = raw as Record<string, unknown>;

  if (obj["version"] !== 1) {
    return DEFAULT_NOTIFY_CONFIG;
  }

  const rules = validateRules(obj["rules"]);
  const llmFallback = typeof obj["llmFallback"] === "boolean" ? obj["llmFallback"] : false;
  const defaultTier = isTier(obj["defaultTier"]) ? obj["defaultTier"] : "medium";

  return { version: 1, llmFallback, defaultTier, rules };
}

function validateRules(raw: unknown): NotifyClassifierRule[] {
  if (!Array.isArray(raw)) {
    return DEFAULT_NOTIFY_CONFIG.rules;
  }
  const result: NotifyClassifierRule[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const obj = item as Record<string, unknown>;
    if (!isTier(obj["tier"])) {
      continue;
    }
    const rule: NotifyClassifierRule = { tier: obj["tier"] };
    if (typeof obj["type"] === "string" && obj["type"]) {
      rule.type = obj["type"];
    }
    if (typeof obj["pattern"] === "string" && obj["pattern"]) {
      rule.pattern = obj["pattern"];
    }
    if (!rule.type && !rule.pattern) {
      continue; // rule with neither type nor pattern is useless
    }
    result.push(rule);
  }
  return result;
}

function isTier(v: unknown): v is NotifyTier {
  return v === "critical" || v === "high" || v === "medium";
}
