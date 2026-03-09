---
title: "Learnings Agent Tools"
summary: "Reference for the learnings_record and learnings_query agent tools: recording corrections, insights, error patterns, and feature requests into the SQL learnings database."
---

# Learnings Agent Tools

Two agent tools expose the SQL learnings database to OpenClaw agents. Both are privacy-gated — they are suppressed in group and channel sessions (same rules as `memory_search`).

**File:** `src/agents/tools/learnings-tool.ts`

## Tool: `learnings_record`

Records a correction, insight, error pattern, or feature request into the learnings database.

### Parameters

| Parameter  | Type   | Required    | Description                                                      |
| ---------- | ------ | ----------- | ---------------------------------------------------------------- |
| `type`     | string | yes         | `learning`, `error_pattern`, or `feature_request`                |
| `content`  | string | conditional | The text to record (required for `learning` and `error_pattern`) |
| `title`    | string | conditional | Short label (required for `feature_request`)                     |
| `category` | string | no          | For `learning`: `correction` (default: `insight`)                |
| `source`   | string | no          | Session key or script name for provenance                        |

### Usage examples

**Record a correction** (user corrected the agent):

```json
{
  "type": "learning",
  "category": "correction",
  "content": "Always use --no-verify flag only when the user explicitly requests it"
}
```

**Record an insight** (agent discovered a useful pattern):

```json
{
  "type": "learning",
  "category": "insight",
  "content": "pnpm test:live requires CLAWDBOT_LIVE_TEST=1 in env, not just LIVE=1"
}
```

**Record an error pattern** (recurring failure signature):

```json
{
  "type": "error_pattern",
  "content": "ECONNREFUSED 127.0.0.1:18789",
  "source": "gateway health check"
}
```

**Record a feature request** (automation idea):

```json
{
  "type": "feature_request",
  "title": "Auto-resolve bot PR review conversations",
  "content": "After fixing a bot-flagged issue, call gh pr review --resolve automatically"
}
```

### Response

```json
{ "ok": true, "type": "learning", "id": 42, "category": "correction" }
```

---

## Tool: `learnings_query`

Queries the learnings database. Returns rows from one of the three tables.

### Parameters

| Parameter  | Type   | Required | Description                                                                     |
| ---------- | ------ | -------- | ------------------------------------------------------------------------------- |
| `type`     | string | yes      | `learning`, `error_pattern`, or `feature_request`                               |
| `keyword`  | string | no       | Filter by content substring (LIKE match)                                        |
| `category` | string | no       | For `learning`: `correction` or `insight`; for `feature_request`: status filter |
| `limit`    | number | no       | Max rows to return (default: 20)                                                |

### Usage examples

**Recall recent corrections** (call at session start):

```json
{
  "type": "learning",
  "category": "correction",
  "limit": 10
}
```

**Search for insights about a topic**:

```json
{
  "type": "learning",
  "category": "insight",
  "keyword": "crontab"
}
```

**List top recurring errors**:

```json
{
  "type": "error_pattern",
  "limit": 20
}
```

**List open feature requests**:

```json
{
  "type": "feature_request",
  "category": "open"
}
```

### Response (learnings)

```json
{
  "type": "learning",
  "count": 3,
  "rows": [
    {
      "id": 12,
      "category": "correction",
      "content": "Always use heredoc for multi-line gh comments",
      "source": "agent:main:telegram:direct:user123",
      "created_at": 1741392000000,
      "updated_at": 1741392000000
    }
  ]
}
```

---

## Registering the Tools

The factory functions follow the same pattern as `createMemorySearchTool`:

```typescript
import { createLearningsRecordTool, createLearningsQueryTool } from "./learnings-tool.js";

const tools = [
  createLearningsRecordTool({ config, agentSessionKey }),
  createLearningsQueryTool({ config, agentSessionKey }),
].filter(Boolean);
```

Both return `null` when:

- `config` is not provided
- The session key indicates a group or channel context

---

## Self-Improvement Workflow (from AGENTS.md)

The [AGENTS.md template](/reference/templates/AGENTS) instructs agents to use these tools as follows:

1. **Session start** — call `learnings_query` (type=learning, category=correction) to recall recent corrections before responding.
2. **On user correction** — call `learnings_record` immediately with type=learning, category=correction.
3. **On useful pattern** — call `learnings_record` with type=learning, category=insight.
4. **On automation idea** — call `learnings_record` with type=feature_request, title=the idea.
