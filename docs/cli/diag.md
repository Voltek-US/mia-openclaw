---
summary: "CLI reference for `openclaw diag` (agent diagnostic toolkit: health checks, cron debugging, log viewer, usage stats)"
read_when:
  - You want to check whether the gateway and agent are healthy
  - You are debugging cron jobs that are failing or stuck
  - You want to tail or search the structured event log
  - You want to see which model and provider are active
  - You want a usage summary across tokens, storage, and API calls
title: "diag"
---

# `openclaw diag`

A self-contained diagnostic toolkit for the OpenClaw agent.
Run any of these commands when something seems off — no gateway restart required.

```bash
openclaw diag --help
```

---

## `diag health`

Run a four-point system health check and print a pass/fail summary.

```bash
openclaw diag health
openclaw diag health --window 30m
openclaw diag health --force
openclaw diag health --json
```

**What it checks:**

| Check                   | How                                                     |
| ----------------------- | ------------------------------------------------------- |
| Gateway port reachable  | TCP probe to `127.0.0.1:<port>` (3 s timeout)           |
| Gateway health RPC      | Calls the `health` method; expects `ok: true`           |
| Recent event-log errors | Scans `data/logs/all.jsonl` for `error`/`fatal` entries |
| Gateway file-log errors | Scans `/tmp/openclaw-gateway.log` for error lines       |

**Options:**

- `--window <duration>` — look-back window for error scanning (default `1h`; e.g. `30m`, `2h`)
- `--force` — print results even when within the alert backoff period
- `--json` — emit raw JSON `{ ok, ts, checks[] }`
- `--url`, `--token`, `--timeout` — gateway connection overrides

**Alert backoff:**

`diag health` tracks alert state in `~/.openclaw/diag/alert-state.json`.
When a failure is detected and the command is wired into a cron job or polling loop,
it uses exponential backoff (starting at 5 minutes, doubling each time, capping at 24 hours)
so you are not flooded with repeated alerts for the same persistent failure.
Use `--force` to bypass the backoff and always print.

**Example output:**

```
=== System Health ===
  PASS  gateway port 18789
  PASS  gateway health RPC
  FAIL  event log (recent errors)  2 error(s) in last 60m
  PASS  gateway file log

Overall: DEGRADED
```

---

## `diag cron history`

Query cron run history with rich filters.

```bash
openclaw diag cron history
openclaw diag cron history --job "morning brief"
openclaw diag cron history --status error --since 6h
openclaw diag cron history --grep "timeout" --limit 20 --json
```

**Options:**

- `--job <name-or-id>` — filter to a specific job; partial match on name, exact match on ID
- `--status <filter>` — `ok`, `error`, `skipped`, or `all` (default `all`)
- `--since <time>` — start of window: ISO date, Unix timestamp (ms), or relative (`2h`, `30m`, `1d`)
- `--until <time>` — end of window (same formats as `--since`)
- `--grep <text>` — case-insensitive substring match across summary/error/job name
- `--limit <n>` — max entries to return (default 50, max 200)
- `--store <path>` — cron store path override (default `~/.openclaw/cron/jobs.json`)
- `--json` — emit raw JSON array

Reads directly from the on-disk run logs at `~/.openclaw/cron/runs/<jobId>.jsonl`.
No gateway connection required.

---

## `diag cron failures`

Detect cron jobs that are **persistently failing** — defined as the same job producing
three or more errors within any rolling 6-hour window.
This distinguishes genuinely broken jobs from isolated one-off errors.

```bash
openclaw diag cron failures
openclaw diag cron failures --threshold 5 --window 12h
openclaw diag cron failures --json
```

**Options:**

- `--threshold <n>` — number of failures to flag (default `3`)
- `--window <duration>` — rolling window to search (default `6h`)
- `--store <path>` — cron store path override
- `--json` — emit raw JSON array of flagged jobs

When a job is flagged, the output shows:

- job name and ID
- failure count
- first and last failure timestamps
- the last error message

---

## `diag cron stale`

List cron jobs that are stuck in the `running` state for longer than two hours.
This happens after a machine sleep, gateway crash, or process kill.
Use `--fix` to clear the stale state via the Gateway.

```bash
# List stale jobs
openclaw diag cron stale

# Auto-clear via Gateway (marks them as failed)
openclaw diag cron stale --fix

# Custom threshold
openclaw diag cron stale --stale-after 30m --fix
```

**Options:**

- `--stale-after <duration>` — how long a job must be stuck before it is considered stale (default `2h`)
- `--fix` — patch stale jobs to `lastRunStatus: error` via the `cron.update` Gateway RPC
- `--store <path>` — cron store path override
- `--json` — emit JSON (without `--fix`: list of stale jobs; with `--fix`: `{ stale, results }`)
- `--url`, `--token`, `--timeout` — gateway connection overrides (required with `--fix`)

Note: listing stale jobs reads the cron store directly and does not require a running gateway.
`--fix` does require the gateway.

---

## `diag logs`

Unified viewer for the structured event log (`data/logs/all.jsonl`).

```bash
# Last 100 entries
openclaw diag logs

# Errors in the last hour
openclaw diag logs --errors

# Everything from the last 15 minutes
openclaw diag logs --recent

# Filter by event name
openclaw diag logs --event api.request

# Event name prefix (all api.* events)
openclaw diag logs --event "api.*"

# Combine filters
openclaw diag logs --level warn --grep "timeout" --since 2h --limit 50

# Raw JSONL for piping
openclaw diag logs --errors --json | jq .message
```

**Options:**

- `--event <name>` — filter by event name; supports exact match or `prefix.*` glob
- `--level <level>` — minimum log level: `trace`, `debug`, `info`, `warn`, `error`, `fatal`
- `--grep <text>` — case-insensitive substring filter across the full log line
- `--since <time>` — start time (ISO date, relative: `1h`, `30m`, `1d`)
- `--until <time>` — end time (same formats)
- `--limit <n>` — max entries to show (default `100`, max `2000`)
- `--errors` — shorthand for `--level error --since 1h`
- `--recent` — shorthand for `--since 15m`
- `--json` — emit raw JSONL (one JSON object per line; omits the summary footer)

**Column format (human output):**

```
<timestamp>  <level>  <event name>             <message>  <extra fields>
```

The event log is written by [src/event-log/writer.ts](../src/event-log/writer.ts).
By default it lives in `data/logs/` relative to the working directory;
set `OPENCLAW_EVENT_LOG_DIR` to override.

---

## `diag model status`

Show the active model, provider, fallback chain, and recent usage.

```bash
openclaw diag model status
openclaw diag model status --json
```

**What it shows:**

- Active model and configured fallbacks (from `models.list` Gateway RPC)
- List of available models with provider and context size
- Most recent heartbeat (timestamp, status, channel)
- Last model and provider used by a cron run (from run logs)
- Models referenced in cron job definitions

**Options:**

- `--store <path>` — cron store path override
- `--json` — emit raw JSON `{ models, heartbeat, cronModels, lastUsedModel, lastUsedProvider, errors }`
- `--url`, `--token`, `--timeout` — gateway connection overrides

---

## `diag model canary`

Lightweight probe to verify the gateway is routing correctly and the provider is reachable.

```bash
openclaw diag model canary
openclaw diag model canary --json
```

**What it checks:**

1. Gateway health RPC (`health` method) — confirms the gateway is up and responding
2. `models.list` RPC — confirms the active model is configured and the provider is reachable
3. Last cron run log entry — surfaces the most recently used model and provider, confirming prior auth succeeded

Unlike a full agent turn, the canary does not consume significant tokens or require a wait.

**Options:**

- `--store <path>` — cron store path override
- `--json` — emit raw JSON result
- `--url`, `--token`, `--timeout` — gateway connection overrides

**Example output:**

```
=== Model Canary Test ===
  PASS  gateway health RPC
  PASS  models.list — active: claude-opus-4-6 (anthropic)
  OK    last cron run at 2026-03-08 14:22:10Z  model=claude-opus-4-6 via anthropic
```

---

## `diag usage`

Aggregated usage dashboard pulling from multiple sources in a single command.

```bash
openclaw diag usage
openclaw diag usage --window 24h
openclaw diag usage --json
```

**What it shows:**

| Section               | Source                                                |
| --------------------- | ----------------------------------------------------- |
| Gateway usage         | `usage.status` and `usage.cost` RPCs                  |
| Cron reliability      | Run logs: success/error/skipped counts, percentages   |
| Token usage by job    | Run logs: input/output token totals per cron job      |
| Event log call counts | Top 10 events by frequency from `data/logs/all.jsonl` |
| Storage sizes         | `~/.openclaw`, sessions, cron store, event logs       |

**Options:**

- `--window <duration>` — look-back window (default `7d`; e.g. `24h`, `30d`)
- `--store <path>` — cron store path override
- `--json` — emit raw JSON `{ gatewayUsage, gatewayCost, cronStats, eventCounts, sizes }`
- `--url`, `--token`, `--timeout` — gateway connection overrides

The gateway RPCs (`usage.status`, `usage.cost`) are optional; if the gateway is offline or
does not support them, those sections are skipped and the rest of the dashboard still renders.

---

## Gateway connection flags

All subcommands that contact the Gateway accept:

- `--url <url>` — WebSocket URL override
- `--token <token>` — gateway token override
- `--timeout <ms>` — RPC timeout in milliseconds (default `30000`)

---

## Common workflows

**Is my agent healthy right now?**

```bash
openclaw diag health
```

**Why did my morning-brief cron fail?**

```bash
openclaw diag cron history --job "morning brief" --status error --since 7d
```

**Are any cron jobs persistently broken?**

```bash
openclaw diag cron failures
```

**My gateway crashed; clean up stuck jobs:**

```bash
openclaw diag cron stale --fix
```

**What errors happened in the last hour?**

```bash
openclaw diag logs --errors
```

**Which model is running, and did auth succeed recently?**

```bash
openclaw diag model canary
```

**How much have I spent on tokens this week?**

```bash
openclaw diag usage --window 7d
```

**Pipe errors into another tool:**

```bash
openclaw diag logs --errors --json | jq '{event: .event, msg: .message}'
```

**Run health checks on a schedule (via cron):**

```bash
# Add to cron: check every 15 minutes, suppress repeated alerts via backoff
openclaw cron add \
  --name "Agent health check" \
  --every 15m \
  --session main \
  --message "$(echo 'openclaw diag health')"
```

---

## Implementation notes

The diagnostic toolkit is implemented in:

- `src/commands/diag/` — command logic (no CLI wiring; importable)
- `src/cli/diag-cli/register.ts` — Commander subcommand definitions (lazy-loaded)
- `src/cli/diag-cli.ts` — re-export entry point

Alert state is persisted at `~/.openclaw/diag/alert-state.json`.

Event logs are read from `$OPENCLAW_EVENT_LOG_DIR` or `data/logs/` relative to the working directory.

Cron run logs are read from `~/.openclaw/cron/runs/<jobId>.jsonl` (or the configured `cron.store` path).
No gateway connection is required for cron history, failure detection, or stale detection — only `--fix` on `cron stale` needs the gateway.
