import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetMemoryToolMockState } from "../../../test/helpers/memory-tool-manager-mock.js";
import type { OpenClawConfig } from "../../config/config.js";
import { createMemoryWriteTool } from "./memory-tool.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function cfg(workspaceDir: string): OpenClawConfig {
  return {
    agents: {
      list: [{ id: "main", default: true, workspace: workspaceDir }],
    },
  } as OpenClawConfig;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-write-"));
  resetMemoryToolMockState({ searchImpl: async () => [] });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("memory_write tool — append behavior", () => {
  it("creates memory dir and daily file on first write", async () => {
    const tool = createMemoryWriteTool({ config: cfg(tmpDir) });
    expect(tool).not.toBeNull();

    const result = await tool!.execute("tid", { content: "Hello from test" });
    const data = result.details as { ok: boolean; path: string };
    expect(data.ok).toBe(true);
    expect(data.path).toMatch(/^memory\/\d{4}-\d{2}-\d{2}\.md$/);

    const files = await fs.readdir(path.join(tmpDir, "memory"));
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.md$/);
  });

  it("appends content with timestamp prefix on each call", async () => {
    const tool = createMemoryWriteTool({ config: cfg(tmpDir) });
    await tool!.execute("tid", { content: "First note" });
    await tool!.execute("tid", { content: "Second note" });

    const memDir = path.join(tmpDir, "memory");
    const [filename] = await fs.readdir(memDir);
    const text = await fs.readFile(path.join(memDir, filename), "utf8");

    expect(text.match(/<!-- \d{2}:\d{2} -->/g)?.length).toBe(2);
    expect(text).toContain("First note");
    expect(text).toContain("Second note");
  });

  it("includes section header when section is provided", async () => {
    const tool = createMemoryWriteTool({ config: cfg(tmpDir) });
    await tool!.execute("tid", { content: "Deploy at noon", section: "Tasks" });

    const memDir = path.join(tmpDir, "memory");
    const [filename] = await fs.readdir(memDir);
    const text = await fs.readFile(path.join(memDir, filename), "utf8");

    expect(text).toContain("## Tasks");
    expect(text).toContain("Deploy at noon");
  });

  it("omits section header when section is not provided", async () => {
    const tool = createMemoryWriteTool({ config: cfg(tmpDir) });
    await tool!.execute("tid", { content: "Just a note" });

    const memDir = path.join(tmpDir, "memory");
    const [filename] = await fs.readdir(memDir);
    const text = await fs.readFile(path.join(memDir, filename), "utf8");

    expect(text).not.toContain("## ");
    expect(text).toContain("Just a note");
  });

  it("returns section:null when no section provided", async () => {
    const tool = createMemoryWriteTool({ config: cfg(tmpDir) });
    const result = await tool!.execute("tid", { content: "bare note" });
    const data = result.details as { ok: boolean; section: string | null };
    expect(data.ok).toBe(true);
    expect(data.section).toBeNull();
  });

  it("returns section name when section is provided", async () => {
    const tool = createMemoryWriteTool({ config: cfg(tmpDir) });
    const result = await tool!.execute("tid", { content: "note", section: "Decisions" });
    const data = result.details as { ok: boolean; section: string };
    expect(data.ok).toBe(true);
    expect(data.section).toBe("Decisions");
  });

  it("daily file name matches today's ISO date", async () => {
    const tool = createMemoryWriteTool({ config: cfg(tmpDir) });
    const result = await tool!.execute("tid", { content: "dated note" });
    const data = result.details as { path: string };
    const today = new Date().toISOString().slice(0, 10);
    expect(data.path).toBe(`memory/${today}.md`);
  });
});
