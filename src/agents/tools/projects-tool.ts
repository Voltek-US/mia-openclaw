import { Type } from "@sinclair/typebox";
import {
  deleteProject,
  getProject,
  insertProject,
  openMiaDb,
  queryProjects,
  updateProject,
} from "../../intelligence/mia-store.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

// ============================================================================
// Privacy gating — same rules as memory-tool.ts / learnings-tool.ts
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

/** Returns true if the session context allows access to personal data. */
function isPrivateSession(sessionKey?: string): boolean {
  return deriveChatType(sessionKey) === "direct";
}

// ============================================================================
// Tool schemas
// ============================================================================

const ProjectUpsertSchema = Type.Object({
  id: Type.String(),
  name: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  url: Type.Optional(Type.String()),
  status: Type.Optional(Type.String()),
  stack: Type.Optional(Type.String()),
  notes: Type.Optional(Type.String()),
});

const ProjectsQuerySchema = Type.Object({
  status: Type.Optional(Type.String()),
  keyword: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Number()),
});

const ProjectDeleteSchema = Type.Object({
  id: Type.String(),
});

// ============================================================================
// Factory: project_upsert
// ============================================================================

/**
 * Create or update a project in mia.sqlite.
 *
 * Use id as a stable slug (e.g. "openclaw-v2"). If the project already exists,
 * only the provided fields are updated. Supply status="completed" when done.
 *
 * DB is opened lazily inside execute to avoid side effects during tool registration.
 */
export function createProjectUpsertTool(options: { agentSessionKey?: string }): AnyAgentTool[] {
  // Projects contain personal/business context — Confidential tier.
  // Return no tool for group/channel sessions.
  if (!isPrivateSession(options.agentSessionKey)) {
    return [];
  }

  return [
    {
      label: "Upsert Project",
      name: "project_upsert",
      description:
        "Create or update a project in the SQL projects registry. " +
        "id is a stable slug (e.g. 'openclaw-v2'). " +
        "status: active | blocked | paused | completed. " +
        "If the project already exists, only supplied fields are updated. " +
        "Tasks and household_tasks can reference projects via their project_id field.",
      parameters: ProjectUpsertSchema,
      execute: async (_toolCallId, params) => {
        const db = openMiaDb();
        if (!db) {
          return jsonResult({ ok: false, error: "Projects DB unavailable" });
        }

        const id = readStringParam(params, "id", { required: true });
        const name = readStringParam(params, "name");
        const description = readStringParam(params, "description");
        const url = readStringParam(params, "url");
        const status = readStringParam(params, "status");
        const stack = readStringParam(params, "stack");
        const notes = readStringParam(params, "notes");

        const existing = getProject(db, id);

        if (!existing) {
          // Insert — name is required for creation.
          if (!name) {
            return jsonResult({ ok: false, error: "name required when creating a new project" });
          }
          const row = insertProject(db, { id, name, description, url, status, stack, notes });
          return jsonResult({ ok: true, action: "created", project: row });
        }

        // Update — only set supplied fields.
        const updated = updateProject(db, id, { name, description, url, status, stack, notes });
        return jsonResult({ ok: true, action: "updated", project: updated });
      },
    },
  ];
}

// ============================================================================
// Factory: projects_query
// ============================================================================

/**
 * List or search projects from mia.sqlite.
 * Use at every heartbeat (status="active") for a compact project registry (~1K tokens).
 *
 * DB is opened lazily inside execute to avoid side effects during tool registration.
 */
export function createProjectsQueryTool(options: { agentSessionKey?: string }): AnyAgentTool[] {
  if (!isPrivateSession(options.agentSessionKey)) {
    return [];
  }

  return [
    {
      label: "Query Projects",
      name: "projects_query",
      description:
        "List or search projects from the SQL projects registry. " +
        "Filter by status (active | blocked | paused | completed) or keyword (searches name/description/notes). " +
        "Call with status='active' at every heartbeat for a compact project registry. " +
        "Returns id, name, url, status, stack, notes, and timestamps for each matching project.",
      parameters: ProjectsQuerySchema,
      execute: async (_toolCallId, params) => {
        const db = openMiaDb();
        if (!db) {
          return jsonResult({ ok: false, error: "Projects DB unavailable" });
        }

        const status = readStringParam(params, "status");
        const keyword = readStringParam(params, "keyword");
        const limitRaw = params["limit"];
        const limit =
          typeof limitRaw === "number" && Number.isFinite(limitRaw)
            ? Math.trunc(limitRaw)
            : undefined;

        const rows = queryProjects(db, { status, keyword, limit });
        return jsonResult({ count: rows.length, projects: rows });
      },
    },
  ];
}

// ============================================================================
// Factory: project_delete
// ============================================================================

/**
 * Delete a project by id. Only use when permanently removing a project.
 * Prefer status="completed" or status="paused" for archiving.
 *
 * DB is opened lazily inside execute to avoid side effects during tool registration.
 */
export function createProjectDeleteTool(options: { agentSessionKey?: string }): AnyAgentTool[] {
  if (!isPrivateSession(options.agentSessionKey)) {
    return [];
  }

  return [
    {
      label: "Delete Project",
      name: "project_delete",
      description:
        "Permanently delete a project by id. " +
        "Prefer setting status='completed' or 'paused' instead of deleting. " +
        "Existing tasks with this project_id will have their project_id set to NULL.",
      parameters: ProjectDeleteSchema,
      execute: async (_toolCallId, params) => {
        const db = openMiaDb();
        if (!db) {
          return jsonResult({ ok: false, error: "Projects DB unavailable" });
        }

        const id = readStringParam(params, "id", { required: true });
        const existing = getProject(db, id);
        if (!existing) {
          return jsonResult({ ok: false, error: `Project not found: ${id}` });
        }
        deleteProject(db, id);
        return jsonResult({ ok: true, deleted: id });
      },
    },
  ];
}
