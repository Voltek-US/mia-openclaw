import type { AnyAgentTool } from "./common.js";

/** A single entry returned by registry search. */
export type ToolRegistryEntry = {
  name: string;
  description: string;
  parameters_schema: unknown;
};

/**
 * Registry of deferred tools — kept out of the initial context window and
 * discovered on demand via tool_search / execute_tool.
 *
 * Search uses token-overlap scoring: name matches are weighted 3× over
 * description matches, with a 1× bonus for prefix matches in the name.
 */
export class DeferredToolRegistry {
  private readonly tools: Map<string, AnyAgentTool>;

  constructor(tools: AnyAgentTool[]) {
    this.tools = new Map(tools.map((t) => [t.name, t]));
  }

  /** Find tools matching the keyword query; returns up to `limit` results. */
  search(query: string, limit = 5): ToolRegistryEntry[] {
    const queryTokens = tokenize(query);
    if (queryTokens.size === 0) {
      // Empty query → return all tools (up to limit)
      return [...this.tools.values()].slice(0, limit).map(toEntry);
    }

    const scored = [...this.tools.values()].map((tool) => ({
      tool,
      score: scoreMatch(tool, queryTokens),
    }));

    return scored
      .filter(({ score }) => score > 0)
      .toSorted((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ tool }) => toEntry(tool));
  }

  /** Look up a tool by exact name. */
  get(name: string): AnyAgentTool | undefined {
    return this.tools.get(name);
  }

  /** All deferred tools as a Map (used by tool_batch). */
  getAll(): ReadonlyMap<string, AnyAgentTool> {
    return this.tools;
  }

  /** Number of deferred tools in the registry. */
  get size(): number {
    return this.tools.size;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toEntry(tool: AnyAgentTool): ToolRegistryEntry {
  return {
    name: tool.name,
    description: tool.description ?? "",
    parameters_schema: tool.parameters,
  };
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[\s_\-./,;:!?]+/)
      .filter((t) => t.length > 1),
  );
}

function scoreMatch(tool: AnyAgentTool, queryTokens: Set<string>): number {
  const nameTokens = tokenize(tool.name);
  const descTokens = tokenize(tool.description ?? "");
  let score = 0;
  for (const qt of queryTokens) {
    if (nameTokens.has(qt)) {
      score += 3; // exact name-token hit
    }
    if (descTokens.has(qt)) {
      score += 1; // description hit
    }
    // Partial prefix hit in name (e.g. "crm" matches "crm_query")
    for (const nt of nameTokens) {
      if (nt !== qt && nt.startsWith(qt)) {
        score += 1;
      }
    }
  }
  return score;
}
