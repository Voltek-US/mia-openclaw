import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";
import type { DeferredToolRegistry } from "./tool-registry.js";

const ToolSearchSchema = Type.Object({
  query: Type.String({
    description:
      "Keyword query to find deferred tools. Use terms related to what you want to do " +
      "(e.g. 'crm contacts', 'project tasks', 'text to speech').",
  }),
  limit: Type.Optional(
    Type.Number({
      description: "Maximum number of tools to return (default 5, max 20).",
    }),
  ),
});

/**
 * Meta-tool that searches the deferred tool registry.
 *
 * Use this before calling execute_tool when you need a tool that may not be
 * in your initial tool list. It returns the name, description, and full
 * parameter schema of matching tools.
 */
export function createToolSearchTool(registry: DeferredToolRegistry): AnyAgentTool {
  return {
    label: "Tool Search",
    name: "tool_search",
    description:
      "Search for available tools that are not in your initial tool list. " +
      "Returns tool names, descriptions, and parameter schemas. " +
      `There are ${registry.size} additional tools discoverable via this tool. ` +
      "After finding a tool, call it via execute_tool.",
    parameters: ToolSearchSchema,
    execute: async (_toolCallId, params) => {
      const query = readStringParam(params, "query", { required: true });
      const rawLimit = readNumberParam(params, "limit", { integer: true });
      const limit = Math.min(rawLimit ?? 5, 20);

      const results = registry.search(query, limit);

      if (results.length === 0) {
        return jsonResult({
          tools: [],
          message: `No deferred tools matched "${query}". Try broader keywords.`,
          total_deferred: registry.size,
        });
      }

      return jsonResult({
        tools: results,
        total_deferred: registry.size,
        hint: "Call execute_tool with the tool name and params to run a discovered tool.",
      });
    },
  };
}
