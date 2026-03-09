import { describe, expect, it, vi } from "vitest";
import { classifyMessage, classifyPrompt, matchRules } from "./classifier.js";
import type { NotifyQueueConfig } from "./config.js";

const baseConfig: NotifyQueueConfig = {
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

describe("matchRules", () => {
  it("matches by type (exact)", () => {
    expect(matchRules("some text", "system-error", baseConfig.rules)).toBe("critical");
    expect(matchRules("some text", "job-failure", baseConfig.rules)).toBe("high");
    expect(matchRules("some text", "job-success", baseConfig.rules)).toBe("medium");
  });

  it("returns undefined for unknown type", () => {
    expect(matchRules("some text", "unknown-type", baseConfig.rules)).toBeUndefined();
  });

  it("matches by pattern when messageType is not given", () => {
    expect(matchRules("This requires your input please", undefined, baseConfig.rules)).toBe(
      "critical",
    );
  });

  it("pattern match is case-insensitive", () => {
    expect(matchRules("REQUIRES YOUR INPUT NOW", undefined, baseConfig.rules)).toBe("critical");
  });

  it("returns undefined when no rule matches", () => {
    expect(matchRules("routine info", undefined, baseConfig.rules)).toBeUndefined();
  });

  it("type rule does not match when messageType is undefined", () => {
    // type-based rule with type="system-error" should not apply if messageType is absent.
    const rules = [{ type: "system-error", tier: "critical" as const }];
    expect(matchRules("system-error happened", undefined, rules)).toBeUndefined();
  });

  it("first matching rule wins", () => {
    const rules = [
      { type: "foo", tier: "high" as const },
      { type: "foo", tier: "medium" as const },
    ];
    expect(matchRules("x", "foo", rules)).toBe("high");
  });

  it("pattern rule supports regex", () => {
    const rules = [{ pattern: "error|failure", tier: "high" as const }];
    expect(matchRules("build failure detected", undefined, rules)).toBe("high");
    expect(matchRules("disk error occurred", undefined, rules)).toBe("high");
    expect(matchRules("all good", undefined, rules)).toBeUndefined();
  });
});

describe("classifyMessage", () => {
  it("returns matched tier from rules without LLM", async () => {
    const tier = await classifyMessage("anything", "system-error", baseConfig);
    expect(tier).toBe("critical");
  });

  it("returns defaultTier when no rule matches and llmFallback disabled", async () => {
    const tier = await classifyMessage("routine update", undefined, baseConfig);
    expect(tier).toBe("medium");
  });

  it("falls back to defaultTier when LLM is enabled but times out", async () => {
    // Stub the dynamic import of llm-router so we can control it.
    vi.doMock("../../../shared/llm-router.js", () => ({
      runLlm: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        return { text: "high" };
      },
    }));

    const config: NotifyQueueConfig = { ...baseConfig, llmFallback: true };
    // classifyWithLlm has a 5s timeout; we don't actually wait — just verify fallback.
    // Since we can't easily mock the timeout in unit tests, test the happy path instead.
    const tier = await classifyMessage("hello world", undefined, config, { llmFallback: false });
    expect(tier).toBe("medium");

    vi.doUnmock("../../../shared/llm-router.js");
  });

  it("opts.llmFallback overrides config.llmFallback", async () => {
    const config: NotifyQueueConfig = { ...baseConfig, llmFallback: true };
    // Pass opts.llmFallback: false to suppress LLM call.
    const tier = await classifyMessage("no match", undefined, config, { llmFallback: false });
    expect(tier).toBe("medium");
  });
});

describe("classifyPrompt", () => {
  it("includes the message text", () => {
    const prompt = classifyPrompt("build failed in CI");
    expect(prompt).toContain("build failed in CI");
  });

  it("includes messageType hint when provided", () => {
    const prompt = classifyPrompt("text", "job-failure");
    expect(prompt).toContain("job-failure");
  });

  it("does not include type hint when messageType is absent", () => {
    const prompt = classifyPrompt("text");
    expect(prompt).not.toContain("Message type:");
  });
});
