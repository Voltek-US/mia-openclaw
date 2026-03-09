import { beforeEach, describe, expect, it } from "vitest";
import { resetMemoryToolMockState } from "../../../test/helpers/memory-tool-manager-mock.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  createMemoryGetTool,
  createMemorySearchTool,
  createMemoryWriteTool,
} from "./memory-tool.js";

function cfg(): OpenClawConfig {
  return { agents: { list: [{ id: "main", default: true }] } } as OpenClawConfig;
}

beforeEach(() => {
  resetMemoryToolMockState({ searchImpl: async () => [] });
});

describe("memory tool context gating", () => {
  // ── private / CLI contexts → tools must be available ──────────────────────

  it("createMemorySearchTool returns tool for direct session key", () => {
    const tool = createMemorySearchTool({
      config: cfg(),
      agentSessionKey: "agent:main:telegram:direct:user123",
    });
    expect(tool).not.toBeNull();
    expect(tool?.name).toBe("memory_search");
  });

  it("createMemorySearchTool returns tool when no session key (CLI/main)", () => {
    const tool = createMemorySearchTool({ config: cfg() });
    expect(tool).not.toBeNull();
  });

  it("createMemoryGetTool returns tool for direct session key", () => {
    const tool = createMemoryGetTool({
      config: cfg(),
      agentSessionKey: "agent:main:telegram:direct:user123",
    });
    expect(tool).not.toBeNull();
    expect(tool?.name).toBe("memory_get");
  });

  it("createMemoryGetTool returns tool when no session key (CLI/main)", () => {
    const tool = createMemoryGetTool({ config: cfg() });
    expect(tool).not.toBeNull();
  });

  // ── shared contexts → tools must be suppressed ────────────────────────────

  it("createMemorySearchTool returns null for group session key", () => {
    const tool = createMemorySearchTool({
      config: cfg(),
      agentSessionKey: "agent:main:telegram:group:g456",
    });
    expect(tool).toBeNull();
  });

  it("createMemorySearchTool returns null for channel session key", () => {
    const tool = createMemorySearchTool({
      config: cfg(),
      agentSessionKey: "agent:main:discord:channel:c789",
    });
    expect(tool).toBeNull();
  });

  it("createMemoryGetTool returns null for group session key", () => {
    const tool = createMemoryGetTool({
      config: cfg(),
      agentSessionKey: "agent:main:slack:group:g111",
    });
    expect(tool).toBeNull();
  });

  it("createMemoryGetTool returns null for channel session key", () => {
    const tool = createMemoryGetTool({
      config: cfg(),
      agentSessionKey: "agent:main:discord:channel:c222",
    });
    expect(tool).toBeNull();
  });

  // ── memory_write gate ─────────────────────────────────────────────────────

  it("createMemoryWriteTool returns tool for direct session key", () => {
    const tool = createMemoryWriteTool({
      config: cfg(),
      agentSessionKey: "agent:main:telegram:direct:user123",
    });
    expect(tool).not.toBeNull();
    expect(tool?.name).toBe("memory_write");
  });

  it("createMemoryWriteTool returns tool when no session key (CLI/main)", () => {
    const tool = createMemoryWriteTool({ config: cfg() });
    expect(tool).not.toBeNull();
  });

  it("createMemoryWriteTool returns null for group session key", () => {
    const tool = createMemoryWriteTool({
      config: cfg(),
      agentSessionKey: "agent:main:telegram:group:g456",
    });
    expect(tool).toBeNull();
  });

  it("createMemoryWriteTool returns null for channel session key", () => {
    const tool = createMemoryWriteTool({
      config: cfg(),
      agentSessionKey: "agent:main:discord:channel:c789",
    });
    expect(tool).toBeNull();
  });
});
