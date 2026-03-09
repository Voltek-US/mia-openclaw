import type { NotifyClassifierRule, NotifyQueueConfig } from "./config.js";
import type { NotifyTier } from "./store.js";

// ============================================================================
// Classification
// ============================================================================

export interface ClassifyOptions {
  /** Override the config's LLM fallback setting. */
  llmFallback?: boolean;
}

/**
 * Classify a message into a priority tier.
 *
 * Matching order:
 * 1. Rules with `type` — checked first when messageType is supplied.
 * 2. Rules with `pattern` — substring or regex match against text.
 * 3. LLM fallback (if enabled and no rule matched).
 * 4. Config defaultTier.
 */
export async function classifyMessage(
  text: string,
  messageType: string | undefined,
  config: NotifyQueueConfig,
  opts: ClassifyOptions = {},
): Promise<NotifyTier> {
  const matched = matchRules(text, messageType, config.rules);
  if (matched) {
    return matched;
  }

  const useLlm = opts.llmFallback ?? config.llmFallback ?? false;
  if (useLlm) {
    const llmTier = await classifyWithLlm(text, messageType);
    if (llmTier) {
      return llmTier;
    }
  }

  return config.defaultTier ?? "medium";
}

/**
 * Pure rule-matching — no I/O. Exported for testability.
 *
 * Returns the first matching tier or undefined.
 */
export function matchRules(
  text: string,
  messageType: string | undefined,
  rules: NotifyClassifierRule[],
): NotifyTier | undefined {
  for (const rule of rules) {
    if (rule.type && messageType) {
      if (rule.type === messageType) {
        return rule.tier;
      }
      continue; // type-based rule — only applies when type is given and matches
    }
    if (rule.pattern) {
      if (matchesPattern(text, rule.pattern)) {
        return rule.tier;
      }
    }
  }
  return undefined;
}

function matchesPattern(text: string, pattern: string): boolean {
  // Try regex first; fall back to substring match.
  try {
    return new RegExp(pattern, "i").test(text);
  } catch {
    return text.toLowerCase().includes(pattern.toLowerCase());
  }
}

/**
 * Build the LLM classification prompt. Exported for testability.
 */
export function classifyPrompt(text: string, messageType?: string): string {
  const typeHint = messageType ? `\nMessage type: ${messageType}` : "";
  return `You are a notification priority classifier. Given the message below, respond with exactly one word: critical, high, or medium.

Tiers:
- critical: system errors, requires immediate user interaction, security alerts
- high: job failures, important updates that need attention soon
- medium: routine updates, informational messages, job successes
${typeHint}
Message: ${text}

Respond with only: critical, high, or medium`;
}

/** Call the LLM router for ambiguous classification. Returns null on error or timeout. */
async function classifyWithLlm(
  text: string,
  messageType: string | undefined,
): Promise<NotifyTier | null> {
  try {
    const { runLlm } = (await import(
      // Using a path relative to the repo root so the shared module resolves
      // correctly in both source and built output.
      "../../../shared/llm-router.js"
    )) as { runLlm: (prompt: string, opts: Record<string, unknown>) => Promise<{ text: string }> };

    const prompt = classifyPrompt(text, messageType);
    const result = await Promise.race([
      runLlm(prompt, { model: "claude-haiku-4-5-20251001", caller: "notify-classifier" }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("LLM classifier timeout")), 5_000),
      ),
    ]);

    return parseLlmTier(result.text);
  } catch {
    // Silently fall back to default tier on any error.
    return null;
  }
}

function parseLlmTier(text: string): NotifyTier | null {
  const normalized = text.trim().toLowerCase();
  if (normalized.includes("critical")) {
    return "critical";
  }
  if (normalized.includes("high")) {
    return "high";
  }
  if (normalized.includes("medium")) {
    return "medium";
  }
  return null;
}
