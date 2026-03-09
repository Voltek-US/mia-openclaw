---
title: "Memory Synthesis"
summary: "Weekly cron that distills daily notes into durable learnings, and heartbeat state tracking."
---

# Memory Synthesis

The memory pipeline has three scheduled jobs that keep the agent's long-term
knowledge current and its heartbeat checks stateful.

| Job              | Frequency             | Script                         |
| ---------------- | --------------------- | ------------------------------ |
| Memory synthesis | Weekly (Sunday 01:00) | `scripts/memory-synthesize.ts` |
| Log ingest       | Nightly (02:00)       | `scripts/log-ingest.ts`        |
| Log rotation     | Daily (03:00)         | `scripts/log-rotate.ts`        |

For the ingest and rotation jobs, see `docs/event-log/cron-setup.md` in the repository.

---

## Memory synthesis cron

`scripts/memory-synthesize.ts` reads `memory/YYYY-MM-DD.md` files from the past
N days, calls `claude-sonnet-4-6` to extract durable items, and writes them into
the **learnings SQLite DB** (`~/.openclaw/agents/main/sessions/learnings.sqlite`).

These items are queryable via the `learnings_query` agent tool, so the agent can
recall synthesized insights across sessions.

### What gets extracted

The LLM classifies each item into one of three categories:

| Category     | Description                                        |
| ------------ | -------------------------------------------------- |
| `preference` | Stable user or workflow preferences                |
| `pattern`    | Recurring situations or requests                   |
| `mistake`    | Errors made, corrections received, things to avoid |

Transient events (one-off tasks, meeting notes) are filtered out. Items with no
long-term value are skipped entirely.

### Running manually

```bash
# Dry run — print extracted items without writing to DB
bun scripts/memory-synthesize.ts --dry-run --verbose

# Normal run — write to default sessions dir
bun scripts/memory-synthesize.ts --verbose

# Override workspace and sessions directories
bun scripts/memory-synthesize.ts \
  --workspace ~/.openclaw/workspace \
  --sessions ~/.openclaw/agents/main/sessions \
  --days 14 \
  --verbose
```

### Options

| Flag                 | Default                            | Description                                        |
| -------------------- | ---------------------------------- | -------------------------------------------------- |
| `--workspace <path>` | `~/.openclaw/workspace`            | Agent workspace dir (where `memory/` lives)        |
| `--sessions <path>`  | `~/.openclaw/agents/main/sessions` | Sessions dir (where `learnings.sqlite` is written) |
| `--days <n>`         | `7`                                | How many past days of daily notes to read          |
| `--dry-run`          | off                                | Print extracted items; skip DB write               |
| `--verbose`          | off                                | Print progress to stdout                           |

### Scheduling with OpenClaw cron

```json
{
  "id": "memory-synthesize",
  "schedule": "0 1 * * 0",
  "command": "node --import tsx/esm scripts/memory-synthesize.ts --verbose"
}
```

### Scheduling with system cron

```cron
# Memory synthesis: weekly on Sunday at 01:00
0 1 * * 0 cd /home/user/openclaw && node --import tsx/esm scripts/memory-synthesize.ts --verbose >> /tmp/memory-synthesize.out 2>&1
```

Replace `/home/user/openclaw` with the actual repository root.

### Verifying a run

```bash
# Check the output log
tail -20 /tmp/memory-synthesize.out

# Count synthesis rows in the learnings DB
sqlite3 ~/.openclaw/agents/main/sessions/learnings.sqlite \
  "SELECT category, count(*) FROM learnings WHERE source LIKE 'synthesis:%' GROUP BY category;"
```

---

## Heartbeat state (`memory/heartbeat-state.json`)

The heartbeat loop uses `memory/heartbeat-state.json` to track the last time
each periodic check ran. This lets the heartbeat stay silent when nothing has
changed and avoid duplicate alerts.

### Schema

```json
{
  "lastEmailCheck": null,
  "lastCalendarCheck": null,
  "lastCronScan": null,
  "lastSecurityAudit": null
}
```

All values are ISO 8601 timestamps (strings) or `null` when a check has not run yet.

### Location

The file lives at `memory/heartbeat-state.json` inside the agent workspace
(default `~/.openclaw/workspace/memory/heartbeat-state.json`). It is committed
to the repository as a seed file with all-null values.

Daily note files (`memory/YYYY-MM-DD.md`) are gitignored; `heartbeat-state.json` is not.

### Resilience

If the file is missing or contains malformed JSON, the heartbeat script resets
all fields to `null` and continues. No crash, no alert.

### Example update (shell script)

```bash
STATE_FILE="$HOME/.openclaw/workspace/memory/heartbeat-state.json"

# Read current state (reset if corrupt)
state=$(cat "$STATE_FILE" 2>/dev/null | jq '.' 2>/dev/null || echo '{}')

# Patch a single field
updated=$(echo "$state" | jq --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '.lastEmailCheck = $ts')

echo "$updated" > "$STATE_FILE"
```

---

## Learnings DB reference

The learnings DB (`learnings.sqlite`) is created automatically by the agent tools
or by the synthesis script. Tables:

| Table              | Purpose                                                              |
| ------------------ | -------------------------------------------------------------------- |
| `learnings`        | Corrections, insights, synthesis items (category + content + source) |
| `error_patterns`   | Recurring error signatures with occurrence counts                    |
| `feature_requests` | Automation ideas and improvement proposals                           |

The `source` field on `learnings` rows is set to `synthesis:YYYY-MM-DD` by the
synthesis script, making it easy to filter synthesized vs. agent-recorded items.

### Query examples

```bash
DB="$HOME/.openclaw/agents/main/sessions/learnings.sqlite"

# All corrections (most recent first)
sqlite3 "$DB" "SELECT content FROM learnings WHERE category='correction' ORDER BY created_at DESC LIMIT 20;"

# Synthesis items from this week
sqlite3 "$DB" "SELECT category, content FROM learnings WHERE source LIKE 'synthesis:%' ORDER BY created_at DESC;"

# Top error patterns by frequency
sqlite3 "$DB" "SELECT pattern, count FROM error_patterns ORDER BY count DESC LIMIT 10;"

# Open feature requests
sqlite3 "$DB" "SELECT title FROM feature_requests WHERE status='open' ORDER BY created_at DESC;"
```
