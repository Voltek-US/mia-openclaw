import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveSessionTranscriptsDirForAgent } from "../../config/sessions/paths.js";
import { parseAgentSessionKey, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";
import {
  addFeatureRequest,
  openLearningsDb,
  queryErrorPatterns,
  queryFeatureRequests,
  queryLearnings,
  recordLearning,
  upsertErrorPattern,
} from "./learnings-store-sqlite.js";

// ============================================================================
// Privacy gating — same rules as memory-tool.ts
// ============================================================================

function deriveChatType(sessionKey?: string): "direct" | "group" | "channel" {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed?.rest) {
    return "direct";
  }
  const tokens = new Set(parsed.rest.toLowerCase().split(":").filter(Boolean));
  if (tokens.has("channel")) {
    return "channel";
  }
  if (tokens.has("group")) {
    return "group";
  }
  return "direct";
}

function resolveLearningsDb(options: { config?: OpenClawConfig; agentSessionKey?: string }) {
  const cfg = options.config;
  if (!cfg) {
    return null;
  }
  // Learnings contain personal corrections and insights — Confidential tier.
  // Only expose in private (direct) conversations.
  const chatType = deriveChatType(options.agentSessionKey);
  if (chatType === "group" || chatType === "channel") {
    return null;
  }
  const agentId = resolveAgentIdFromSessionKey(options.agentSessionKey);
  const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId);
  const db = openLearningsDb(sessionsDir);
  return db;
}

// ============================================================================
// Tool schemas
// ============================================================================

const LearningsRecordSchema = Type.Object({
  type: Type.String(),
  content: Type.Optional(Type.String()),
  title: Type.Optional(Type.String()),
  category: Type.Optional(Type.String()),
  source: Type.Optional(Type.String()),
});

const LearningsQuerySchema = Type.Object({
  type: Type.String(),
  keyword: Type.Optional(Type.String()),
  category: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Number()),
});

// ============================================================================
// Factory: learnings_record
// ============================================================================

/**
 * Tool for recording corrections, insights, error patterns, and feature requests
 * into the SQL learnings database.
 *
 * type = "learning"         → category should be "correction" or "insight"
 * type = "error_pattern"    → content is the error pattern string
 * type = "feature_request"  → title (required) + optional content as description
 */
export function createLearningsRecordTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
  agentId?: string;
  agentChannel?: unknown;
}): AnyAgentTool[] {
  const db = resolveLearningsDb(options);
  if (!db) {
    return [];
  }
  return [
    {
      label: "Record Learning",
      name: "learnings_record",
      description:
        "Persist a correction, insight, error pattern, or feature request to the SQL learnings database. " +
        "Use type='learning' with category='correction' when the user corrects you; " +
        "category='insight' for useful patterns discovered. " +
        "Use type='error_pattern' to record a recurring error signature. " +
        "Use type='feature_request' with title for automation ideas.",
      parameters: LearningsRecordSchema,
      execute: async (_toolCallId, params) => {
        const type = readStringParam(params, "type", { required: true });
        const content = readStringParam(params, "content");
        const title = readStringParam(params, "title");
        const category = readStringParam(params, "category");
        const source = readStringParam(params, "source");

        if (type === "learning") {
          const cat = category ?? "insight";
          const text = content ?? title ?? "";
          if (!text) {
            return jsonResult({ ok: false, error: "content required for type=learning" });
          }
          const id = recordLearning(db, { category: cat, content: text, source });
          return jsonResult({ ok: true, type, id, category: cat });
        }

        if (type === "error_pattern") {
          const pattern = content ?? title;
          if (!pattern) {
            return jsonResult({ ok: false, error: "content required for type=error_pattern" });
          }
          upsertErrorPattern(db, { pattern, example: source });
          return jsonResult({ ok: true, type, pattern });
        }

        if (type === "feature_request") {
          const frTitle = title ?? content;
          if (!frTitle) {
            return jsonResult({ ok: false, error: "title required for type=feature_request" });
          }
          const id = addFeatureRequest(db, {
            title: frTitle,
            description: content !== frTitle ? content : undefined,
          });
          return jsonResult({ ok: true, type, id, title: frTitle });
        }

        return jsonResult({ ok: false, error: `unknown type: ${type}` });
      },
    },
  ];
}

// ============================================================================
// Factory: learnings_query
// ============================================================================

/**
 * Tool for querying the SQL learnings database.
 *
 * type = "learning"         → returns correction/insight rows
 * type = "error_pattern"    → returns error pattern rows (sorted by frequency)
 * type = "feature_request"  → returns feature requests
 */
export function createLearningsQueryTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
  agentId?: string;
  agentChannel?: unknown;
}): AnyAgentTool[] {
  const db = resolveLearningsDb(options);
  if (!db) {
    return [];
  }
  return [
    {
      label: "Query Learnings",
      name: "learnings_query",
      description:
        "Query the SQL learnings database for past corrections, insights, error patterns, or feature requests. " +
        "Call at session start with type='learning' and category='correction' to recall recent corrections. " +
        "Use keyword to filter by content substring.",
      parameters: LearningsQuerySchema,
      execute: async (_toolCallId, params) => {
        const type = readStringParam(params, "type", { required: true });
        const keyword = readStringParam(params, "keyword");
        const category = readStringParam(params, "category");
        const limit = readNumberParam(params, "limit", { integer: true });

        if (type === "learning") {
          const rows = queryLearnings(db, { category, keyword, limit });
          return jsonResult({ type, rows, count: rows.length });
        }

        if (type === "error_pattern") {
          const rows = queryErrorPatterns(db, { limit });
          return jsonResult({ type, rows, count: rows.length });
        }

        if (type === "feature_request") {
          const rows = queryFeatureRequests(db, { status: category, limit });
          return jsonResult({ type, rows, count: rows.length });
        }

        return jsonResult({ ok: false, error: `unknown type: ${type}` });
      },
    },
  ];
}
