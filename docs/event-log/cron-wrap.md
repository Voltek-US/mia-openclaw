---
title: "Cron Wrapper Script"
summary: "Shell wrapper that adds PID-based duplicate prevention, signal traps, timeout enforcement, and cron log DB integration to any command."
---

# Cron Wrapper Script (`scripts/cron-wrap.sh`)

`cron-wrap.sh` is a thin Bash wrapper that makes any shell command safe to run as a cron job. It handles the reliability concerns that scripts themselves should not have to worry about:

- **Duplicate prevention** — PID lockfile prevents two instances of the same job running at once
- **Signal handling** — `SIGTERM`/`SIGINT`/`SIGHUP` cleanly stop the child and record the outcome
- **Timeout enforcement** — optional wall-clock timeout, with exit code `124` on breach
- **Automatic logging** — calls `cron-log-db.ts log-start` / `log-end` before and after the command

---

## Usage

```bash
bash scripts/cron-wrap.sh --job <name> [--timeout <seconds>] [--db <path>] -- <command> [args...]
```

| Option                | Description                                                                           |
| --------------------- | ------------------------------------------------------------------------------------- |
| `--job <name>`        | **Required.** Must match `[a-zA-Z0-9_-]+`. Used as the log key and PID lock filename. |
| `--timeout <seconds>` | Optional. Kill the command after this many seconds (exit `124`).                      |
| `--db <path>`         | Optional. Path to `cron-log.db`. Also accepts `OPENCLAW_CRON_LOG_DB` env var.         |
| `--`                  | Separator. Everything after `--` is the command to run.                               |

---

## Examples

```bash
# Basic usage
bash scripts/cron-wrap.sh --job event-log-ingest -- \
  bun scripts/log-ingest.ts --verbose

# With a 5-minute timeout
bash scripts/cron-wrap.sh --job event-log-rotate --timeout 300 -- \
  bun scripts/log-rotate.ts --archive-db --verbose

# With explicit DB path
bash scripts/cron-wrap.sh --job my-job --db /var/data/cron-log.db -- \
  python3 /opt/scripts/my-job.py

# Idempotency: skip if already succeeded today
if bun scripts/cron-log-db.ts should-run my-nightly-job --window today; then
  bash scripts/cron-wrap.sh --job my-nightly-job -- bun scripts/my-nightly-job.ts
fi
```

---

## Execution Flow

```
cron-wrap.sh starts
  │
  ├─ Validate --job name
  ├─ Check PID lock (~/.openclaw/cron-locks/<job>.pid)
  │    ├─ Lock exists + process alive  → print "already running", exit 0 (skip)
  │    └─ Lock exists + process dead   → remove stale lock, continue
  │
  ├─ bun scripts/cron-log-db.ts log-start <job> --pid $$  → RUN_ID
  ├─ Write PID file
  ├─ Register SIGTERM / SIGINT / SIGHUP traps
  │
  ├─ Launch command (with optional `timeout <secs>` prefix)
  │
  └─ Command exits
       ├─ exit 0   → log-end <RUN_ID> ok
       ├─ exit 124 → log-end <RUN_ID> timeout
       └─ other    → log-end <RUN_ID> error --error "exit <N>"
  │
  └─ Remove PID file; exit with same code as command
```

If a signal is received while the command is running:

1. Child process group is sent `SIGTERM`, then `SIGKILL` after 1 second
2. `log-end <RUN_ID> interrupted` is recorded
3. PID file is removed
4. Wrapper exits `130`

---

## PID Lockfile

Lock files are stored at:

```
~/.openclaw/cron-locks/<job-name>.pid
```

The directory is created automatically. Each file contains only the PID of the wrapper process.

If the lock file exists but the process is gone (crash, reboot), the wrapper removes it and proceeds. A stale lock never blocks the job permanently.

---

## Exit Codes

| Code  | Meaning                                                        |
| ----- | -------------------------------------------------------------- |
| `0`   | Command succeeded (or job was skipped because already running) |
| `1`   | Command failed                                                 |
| `124` | Command exceeded `--timeout`                                   |
| `130` | Wrapper was interrupted by a signal                            |

---

## Using with OpenClaw Cron (`agentTurn` payload)

When an `agentTurn` job needs to run a shell command with locking and logging, include the wrapper call in the prompt:

```json
{
  "id": "event-log-ingest",
  "schedule": { "kind": "cron", "expr": "0 2 * * *" },
  "payload": {
    "kind": "agentTurn",
    "message": "Run event log ingest:\nbash scripts/cron-wrap.sh --job event-log-ingest -- bun scripts/log-ingest.ts --verbose\nReport the JSON summary and any errors."
  }
}
```

---

## Using with System Cron

```cron
# Nightly ingest via wrapper (PID lock + DB logging)
7 2 * * * cd /home/user/openclaw && bash scripts/cron-wrap.sh --job event-log-ingest -- bun scripts/log-ingest.ts --verbose >> /tmp/cron-ingest.out 2>&1

# Daily rotation with 10-minute timeout
7 3 * * * cd /home/user/openclaw && bash scripts/cron-wrap.sh --job event-log-rotate --timeout 600 -- bun scripts/log-rotate.ts --archive-db --verbose >> /tmp/cron-rotate.out 2>&1
```

---

## Requirements

- Bash 4+
- `bun` on `PATH` (fallback: `node --import tsx/esm`)
- `scripts/cron-log-db.ts` present in the same `scripts/` directory
- `setsid` available (standard on Linux; macOS: install via `util-linux`)
