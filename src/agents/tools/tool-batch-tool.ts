import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, ToolInputError } from "./common.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const BatchStepSchema = Type.Object(
  {
    id: Type.String({
      description:
        "Unique step identifier, used for referencing results in later steps (e.g. 's1').",
    }),
    tool: Type.String({
      description: "Name of the tool to call (core or deferred).",
    }),
    params: Type.Object(
      {},
      {
        additionalProperties: true,
        description:
          "Parameters for the tool. String values may reference earlier step results " +
          'using dot-path notation: "$s1.results[0].url".',
      },
    ),
    after: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "Step IDs that must complete before this step starts. " +
          "Omit to run sequentially after the previous step. " +
          "Set to [] to run in parallel with all other steps that have no `after` deps.",
      }),
    ),
  },
  { additionalProperties: false },
);

const ToolBatchSchema = Type.Object(
  {
    steps: Type.Array(BatchStepSchema, {
      description: "Ordered list of tool calls. Steps with no `after` deps run sequentially.",
    }),
  },
  { additionalProperties: false },
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type BatchStep = {
  id: string;
  tool: string;
  params: Record<string, unknown>;
  after?: string[];
};

type StepOutcome = { ok: true; result: unknown } | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Tool that executes multiple tool calls in a single agent turn.
 *
 * Steps run sequentially by default. Set `after: []` on a step to make it
 * run in parallel with other `after`-free steps that precede it. Downstream
 * steps use `after: ["s1", "s2"]` to wait for specific predecessors.
 *
 * String parameter values may reference previous results using dot-path
 * syntax: `"$s1.results[0].url"` resolves to `results.s1.result.results[0].url`.
 *
 * Eliminates N inference round-trips for multi-step workflows where
 * intermediate results don't require model interpretation.
 */
export function createToolBatchTool(allTools: Map<string, AnyAgentTool>): AnyAgentTool {
  return {
    label: "Tool Batch",
    name: "tool_batch",
    description:
      "Execute multiple tool calls in one turn. " +
      "Steps run sequentially by default; use `after: []` to enable parallel execution. " +
      'Reference earlier results with "$stepId.field.path" in param strings. ' +
      "Returns all step outcomes in a single response.",
    parameters: ToolBatchSchema,
    execute: async (toolCallId, params) => {
      const rawSteps = params["steps"];
      if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
        throw new ToolInputError("steps must be a non-empty array.");
      }

      const steps = rawSteps as BatchStep[];

      // Validate all step IDs are unique and all tool names exist
      const stepIds = new Set<string>();
      for (const step of steps) {
        if (!step.id || typeof step.id !== "string") {
          throw new ToolInputError("Each step must have a string id.");
        }
        if (stepIds.has(step.id)) {
          throw new ToolInputError(`Duplicate step id: "${step.id}".`);
        }
        stepIds.add(step.id);
        if (!step.tool || typeof step.tool !== "string") {
          throw new ToolInputError(`Step "${step.id}" must have a string tool name.`);
        }
        if (!allTools.has(step.tool)) {
          const available = [...allTools.keys()].slice(0, 10).join(", ");
          throw new ToolInputError(
            `Step "${step.id}": unknown tool "${step.tool}". ` +
              `Available (first 10): ${available}. Use tool_search to discover tools.`,
          );
        }
      }

      // Execute steps respecting dependency graph
      const results = new Map<string, StepOutcome>();
      const stepMap = new Map(steps.map((s) => [s.id, s]));

      // Execution order: topological sort + parallel groups
      await executeSteps(steps, stepMap, results, toolCallId, allTools);

      // Format output
      const output = steps.map((step) => {
        const outcome = results.get(step.id);
        if (!outcome) {
          return { id: step.id, tool: step.tool, error: "Step did not execute." };
        }
        if (!outcome.ok) {
          return { id: step.id, tool: step.tool, error: outcome.error };
        }
        return { id: step.id, tool: step.tool, result: outcome.result };
      });

      return jsonResult({ steps: output });
    },
  };
}

// ---------------------------------------------------------------------------
// Execution engine
// ---------------------------------------------------------------------------

/**
 * Execute steps respecting the dependency graph.
 *
 * - Steps with no `after` field run sequentially in declaration order.
 * - Consecutive steps that ALL have `after` fields (including `after: []`)
 *   and whose deps are already resolved run as a parallel batch.
 *
 * Example:
 *   { id: "a" }          → sequential
 *   { id: "b", after: [] } → parallel with c
 *   { id: "c", after: [] } → parallel with b
 *   { id: "d", after: ["b", "c"] } → waits for b + c
 */
async function executeSteps(
  steps: BatchStep[],
  _stepMap: Map<string, BatchStep>,
  results: Map<string, StepOutcome>,
  toolCallId: string,
  allTools: Map<string, AnyAgentTool>,
): Promise<void> {
  let i = 0;
  while (i < steps.length) {
    // Collect consecutive steps that have an explicit `after` field and whose
    // deps are already satisfied — these form a parallel wave.
    const wave: BatchStep[] = [];
    let j = i;
    while (j < steps.length) {
      const step = steps[j];
      if (step.after === undefined) {
        break;
      } // no `after` → sequential; stop wave
      const depsOk = step.after.every((dep) => results.has(dep));
      if (!depsOk) {
        break;
      } // unresolved dep → stop wave
      wave.push(step);
      j++;
    }

    if (wave.length > 1) {
      // Run parallel batch
      await Promise.all(wave.map((s) => runStep(s, results, toolCallId, allTools)));
      i = j;
    } else if (wave.length === 1) {
      // Single explicit-after step (deps satisfied)
      await runStep(wave[0], results, toolCallId, allTools);
      i++;
    } else {
      // Sequential step (no `after` field)
      await runStep(steps[i], results, toolCallId, allTools);
      i++;
    }
  }
}

async function runStep(
  step: BatchStep,
  results: Map<string, StepOutcome>,
  toolCallId: string,
  allTools: Map<string, AnyAgentTool>,
): Promise<void> {
  const tool = allTools.get(step.tool);
  if (!tool?.execute) {
    results.set(step.id, { ok: false, error: `Tool "${step.tool}" has no execute handler.` });
    return;
  }

  try {
    const resolvedParams = resolveRefs(step.params, results);
    const toolResult: AgentToolResult<unknown> = await tool.execute(toolCallId, resolvedParams);

    // Extract the JSON payload from the tool result for downstream $ref resolution
    let parsedResult: unknown = toolResult;
    if (Array.isArray(toolResult?.content)) {
      for (const block of toolResult.content) {
        if (block.type === "text" && typeof block.text === "string") {
          try {
            parsedResult = JSON.parse(block.text);
          } catch {
            parsedResult = block.text;
          }
          break;
        }
      }
    }

    results.set(step.id, { ok: true, result: parsedResult });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    results.set(step.id, { ok: false, error: message });
  }
}

// ---------------------------------------------------------------------------
// $ref resolution
// ---------------------------------------------------------------------------

/**
 * Recursively walk `value` and replace any string matching `$stepId.path`
 * with the resolved value from prior step results.
 *
 * Examples:
 *   "$s1"              → full result of step s1
 *   "$s1.results"      → results.s1.result.results
 *   "$s1.results[0]"   → first element
 *   "$s1.url"          → results.s1.result.url
 */
function resolveRefs(value: unknown, results: Map<string, StepOutcome>): Record<string, unknown> {
  return resolveValue(value, results) as Record<string, unknown>;
}

function resolveValue(value: unknown, results: Map<string, StepOutcome>): unknown {
  if (typeof value === "string") {
    return resolveStringRef(value, results);
  }
  if (Array.isArray(value)) {
    return value.map((v) => resolveValue(v, results));
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveValue(v, results);
    }
    return out;
  }
  return value;
}

function resolveStringRef(str: string, results: Map<string, StepOutcome>): unknown {
  if (!str.startsWith("$")) {
    return str;
  }
  // "$s1.foo.bar[0]" → stepId="s1", path=["foo","bar","0"]
  const withoutDollar = str.slice(1);
  const dotIdx = withoutDollar.indexOf(".");
  const stepId = dotIdx === -1 ? withoutDollar : withoutDollar.slice(0, dotIdx);
  const rest = dotIdx === -1 ? "" : withoutDollar.slice(dotIdx + 1);

  const outcome = results.get(stepId);
  if (!outcome?.ok) {
    // Step failed or not found — return the original string
    return str;
  }

  if (!rest) {
    return outcome.result;
  }

  // Walk the dot path, handling array brackets
  return walkPath(outcome.result, rest);
}

function walkPath(obj: unknown, path: string): unknown {
  // Split on "." but also handle "foo[0].bar" → ["foo", "0", "bar"]
  const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (Array.isArray(current)) {
      const idx = Number(part);
      current = Number.isInteger(idx) ? (current as unknown[])[idx] : undefined;
    } else if (typeof current === "object") {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}
