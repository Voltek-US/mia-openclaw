import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { readStringParam, ToolInputError } from "./common.js";
import type { DeferredToolRegistry } from "./tool-registry.js";

const ToolExecuteSchema = Type.Object(
  {
    tool_name: Type.String({
      description: "Exact name of the deferred tool to call (as returned by tool_search).",
    }),
    params: Type.Object(
      {},
      {
        additionalProperties: true,
        description: "Parameters to pass to the tool (use the schema from tool_search).",
      },
    ),
  },
  { additionalProperties: false },
);

/**
 * Proxy that dispatches to any deferred tool by name.
 *
 * Workflow:
 *   1. Call tool_search to find the right tool and see its parameter schema.
 *   2. Call execute_tool with the tool name and params.
 *
 * This keeps extended tool schemas out of the initial context window while
 * still making every tool callable.
 */
export function createToolExecuteTool(registry: DeferredToolRegistry): AnyAgentTool {
  return {
    label: "Execute Tool",
    name: "execute_tool",
    description:
      "Call a deferred tool by name. Use tool_search first to find the right tool " +
      "and its parameter schema, then call it here.",
    parameters: ToolExecuteSchema,
    execute: async (toolCallId, params) => {
      const toolName = readStringParam(params, "tool_name", { required: true });
      const tool = registry.get(toolName);

      if (!tool) {
        const candidates = registry
          .search(toolName, 3)
          .map((e) => e.name)
          .join(", ");
        throw new ToolInputError(
          `Unknown deferred tool "${toolName}". ` +
            (candidates
              ? `Did you mean: ${candidates}? Use tool_search to discover available tools.`
              : "Use tool_search to discover available tools."),
        );
      }

      if (!tool.execute) {
        throw new ToolInputError(`Tool "${toolName}" has no execute handler.`);
      }

      const toolParams =
        typeof params["params"] === "object" && params["params"] !== null
          ? (params["params"] as Record<string, unknown>)
          : {};

      return tool.execute(toolCallId, toolParams);
    },
  };
}

/**
 * Build a unified tool lookup map from core + deferred tools.
 * Used by tool_batch to dispatch to any tool regardless of deferral status.
 */
export function buildAllToolsMap(
  coreTools: AnyAgentTool[],
  registry: DeferredToolRegistry,
): Map<string, AnyAgentTool> {
  const map = new Map<string, AnyAgentTool>();
  for (const tool of coreTools) {
    map.set(tool.name, tool);
  }
  for (const [name, tool] of registry.getAll()) {
    map.set(name, tool);
  }
  return map;
}
