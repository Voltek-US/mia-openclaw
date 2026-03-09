# Notification Priority Queue

OpenClaw's notification priority queue batches outbound notifications by importance tier, delivering critical alerts immediately and grouping lower-priority updates into digests. It stores all notifications in a local SQLite database before delivery, so nothing is lost if the gateway restarts mid-flush.

## Tiers

| Tier       | Delivery               | Use for                                                |
| ---------- | ---------------------- | ------------------------------------------------------ |
| `critical` | Immediately on enqueue | System errors, interactive prompts, security alerts    |
| `high`     | Batched hourly         | Job failures, important updates                        |
| `medium`   | Batched every 3 hours  | Routine updates, job successes, informational messages |

## Quick Start

### From a bash script

```bash
# Enqueue a notification (auto-classifies by default)
./scripts/notify.sh --channel telegram "Build failed on main"

# Specify tier explicitly
./scripts/notify.sh --tier high --channel telegram "Deployment failed"

# Send immediately, bypassing the queue
./scripts/notify.sh --tier critical --channel telegram --bypass "Gateway is down"

# Flush the high-priority queue manually
./scripts/notify.sh --flush --tier high
```

### From the CLI

```bash
# Enqueue
openclaw notify enqueue --channel telegram --tier high "Job nightly-sync failed"

# Enqueue with topic (groups messages in digest)
openclaw notify enqueue --channel telegram --topic ci --type job-failure "Build #42 failed"

# Send immediately without queueing
openclaw notify enqueue --channel telegram --bypass "Urgent: disk full"

# Flush a tier (normally done by cron)
openclaw notify flush --tier high

# Show pending counts by tier
openclaw notify status

# List pending messages
openclaw notify list
openclaw notify list --tier medium --json
```

### From TypeScript

```ts
import { notifyViaQueue } from "./src/infra/outbound/deliver.js";

// Auto-classified, queued
await notifyViaQueue({
  message: "Job failed: exit code 1",
  messageType: "job-failure",
  channel: "telegram",
  topic: "ci",
});

// Delivered immediately
await notifyViaQueue({
  message: "System error: OOM",
  messageType: "system-error",
  channel: "telegram",
  bypass: true,
});
```

## Classification

Messages are assigned a tier by matching rules in order. The first match wins.

### Config file

Create `~/.openclaw/notify-queue-config.json`:

```json
{
  "version": 1,
  "llmFallback": false,
  "defaultTier": "medium",
  "rules": [
    { "type": "system-error", "tier": "critical" },
    { "type": "interactive-prompt", "tier": "critical" },
    { "pattern": "requires your input", "tier": "critical" },
    { "type": "job-failure", "tier": "high" },
    { "type": "job-success", "tier": "medium" }
  ]
}
```

Each rule has either a `type` (matched against the caller-supplied `--type` / `messageType`) or a `pattern` (substring or regex tested against the message text). If no rule matches and `llmFallback` is false, `defaultTier` is used.

### LLM fallback

Set `"llmFallback": true` to enable an LLM classifier for messages that don't match any rule. It uses `claude-haiku-4-5-20251001` with a 5-second timeout and falls back to `defaultTier` on error or timeout. Keep this off in high-volume or latency-sensitive paths.

### Message types (built-in defaults)

| `messageType`        | Default tier |
| -------------------- | ------------ |
| `system-error`       | critical     |
| `interactive-prompt` | critical     |
| `job-failure`        | high         |
| `job-success`        | medium       |

Add your own types to the config rules.

## Digest format

When a tier is flushed, messages are grouped by `(channel, topic)` and delivered as a digest:

```
[OpenClaw Digest — 3 updates]

--- ci (2) ---
• Job "nightly-sync" failed: exit code 1
• Job "report-gen" timed out after 120s

--- system (1) ---
• Low disk space: 91% used

---
Delivered by OpenClaw notify-queue
```

A single message with no topic is delivered as plain text (no digest wrapper).

## Cron jobs

Two flush jobs are registered automatically at gateway startup:

| Job name              | Schedule                        | Flushes     |
| --------------------- | ------------------------------- | ----------- |
| `notify-flush-high`   | `0 * * * *` (top of every hour) | high tier   |
| `notify-flush-medium` | `0 */3 * * *` (every 3 hours)   | medium tier |

Jobs are idempotent — checked by name before adding, so gateway restarts don't create duplicates. Verify they are registered:

```bash
openclaw cron list
```

## Shell wrapper reference

`scripts/notify.sh` is a thin wrapper around the CLI for use in bash scripts and cron jobs.

```
Usage: notify.sh [OPTIONS] <message>
       notify.sh --flush --tier high|medium|critical

Options:
  --tier    critical|high|medium   Priority tier
  --channel <channel>              Target channel (required)
  --topic   <topic>                Group label for digest
  --type    <msgType>              Message type for classification rules
  --bypass                         Send immediately, skip queue
  --flush                          Flush pending messages for the tier

Environment variables:
  NOTIFY_TIER      Default tier (default: medium)
  NOTIFY_CHANNEL   Default channel
  OPENCLAW_BIN     Path to openclaw binary (default: openclaw)
```

Exit codes:

- `critical` enqueue/send failure → exits 1 (blocking)
- `high`/`medium` enqueue failure → exits 0 with a warning to stderr (non-blocking)

## Storage

All notifications are stored in `~/.openclaw/notify-queue.sqlite`. The schema:

```sql
notify_queue (
  id            TEXT PRIMARY KEY,
  tier          TEXT NOT NULL,   -- critical | high | medium
  channel       TEXT NOT NULL,
  topic         TEXT,
  message       TEXT NOT NULL,
  message_type  TEXT,
  enqueued_at   INTEGER NOT NULL,
  delivered_at  INTEGER,         -- NULL = pending
  metadata_json TEXT
)
```

Delivered entries are retained for 7 days by default, then pruned. Trigger manual pruning:

```bash
openclaw notify flush --tier high --prune
```

## Source layout

```
src/infra/notify-queue/
  store.ts        SQLite open/cache, schema, CRUD
  config.ts       Config file loader + types
  classifier.ts   Rule matching + LLM fallback
  flush.ts        Digest builder + tier flush

src/cli/notify-cli/
  register.ts     CLI subcommands (enqueue, flush, list, status)
  index.ts        Re-export

scripts/notify.sh  Bash wrapper

src/infra/outbound/deliver.ts   notifyViaQueue() export
src/gateway/server-cron.ts      registerBuiltinNotifyFlushJobs()
src/gateway/server.impl.ts      Gateway startup wiring
```

## Integration patterns

### In a CI/CD script

```bash
#!/usr/bin/env bash
set -euo pipefail

export NOTIFY_CHANNEL=telegram
export NOTIFY_TIER=high

run_build() {
  # ... build steps ...
}

if run_build; then
  ./scripts/notify.sh --type job-success "Build succeeded on $(git rev-parse --short HEAD)"
else
  ./scripts/notify.sh --type job-failure --tier high "Build FAILED on $(git rev-parse --short HEAD)"
fi
```

### In a cron script

```bash
#!/usr/bin/env bash
# Run as a system cron job; failures are non-blocking for high/medium

NOTIFY_CHANNEL=telegram ./scripts/notify.sh --topic "nightly-report" \
  "Nightly sync completed: $(date -u +%Y-%m-%d)"
```

### Registering custom cron flush jobs

If you want to change the flush schedule, remove the auto-registered jobs and add your own:

```bash
# Remove the built-in job
openclaw cron list --json | jq -r '.[] | select(.name == "notify-flush-high") | .id' \
  | xargs -I{} openclaw cron rm {}

# Add a custom schedule (every 30 minutes)
openclaw cron add \
  --name notify-flush-high-custom \
  --schedule "*/30 * * * *" \
  --payload-kind systemEvent \
  --payload-text "openclaw notify flush --tier high" \
  --delivery-mode none
```
