---
title: "Post-Tool-Use Hook"
summary: "Passive error pattern capture: a Claude Code PostToolUse hook that scans every tool result for error signatures and writes them to the learnings database."
---

# Post-Tool-Use Hook (`scan-tool-output.ts`)

The hook runs after every Claude Code tool call and scans the output for error signatures. Matching patterns are upserted into the `error_patterns` table in the learnings database. This happens silently — the hook always exits 0 and never blocks tool execution.

**File:** `scripts/hooks/scan-tool-output.ts`

**Registration:** `~/.claude/settings.json`

## How It Works

```
Claude Code executes a tool
  └─ PostToolUse event fires
       └─ hook reads JSON from stdin
            ├─ no error detected → exit 0 (no-op)
            └─ error detected → upsert into error_patterns table → exit 0
```

The hook receives a JSON event on stdin:

```json
{
  "tool_name": "Bash",
  "tool_input": { "command": "..." },
  "tool_response": {
    "output": "...",
    "error": "..."
  }
}
```

It scans `tool_response.output` and `tool_response.error` (up to 4 000 chars) against these signatures:

| Pattern                                           | Examples                                     |
| ------------------------------------------------- | -------------------------------------------- |
| `Error: <message>`                                | `Error: Cannot read properties of undefined` |
| `ENOENT / ECONNREFUSED / EACCES / ETIMEDOUT`      | File not found, connection refused           |
| `TypeError / ReferenceError / SyntaxError`        | JavaScript runtime errors                    |
| `Cannot find module`                              | Missing import                               |
| `command not found`                               | Missing binary                               |
| `403 / 401 / 404 / 500 … error / failed / denied` | HTTP error codes                             |
| `timeout … ms / seconds / expired`                | Request and process timeouts                 |
| `npm ERR! / pnpm ERR!`                            | Package manager errors                       |

The matched pattern is normalized (whitespace collapsed, truncated to 120 chars) for deduplication.

## Configuration

The hook is registered in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": ".*",
        "hooks": [
          {
            "type": "command",
            "command": "cd /home/openclaw/openclaw && bun scripts/hooks/scan-tool-output.ts"
          }
        ]
      }
    ]
  }
}
```

The `matcher` field matches all tools (`.*`). Narrow it to specific tools if needed:

```json
"matcher": "Bash|Edit|Write"
```

## Database Target

Patterns are written to the default agent's learnings database:

```
~/.openclaw/agents/main/sessions/learnings.sqlite  →  error_patterns table
```

Set `OPENCLAW_HOME` to override the `~/.openclaw` base path.

## Verifying the Hook

Trigger a tool call that produces an error (e.g., a failing Bash command), then query the database:

```bash
sqlite3 ~/.openclaw/agents/main/sessions/learnings.sqlite \
  "SELECT pattern, count, last_seen FROM error_patterns ORDER BY last_seen DESC LIMIT 5;"
```

## Disabling the Hook

Remove the `PostToolUse` block from `~/.claude/settings.json` or delete the entry entirely.
