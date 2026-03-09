---
title: "Cron Setup — Event-Log Automation"
summary: "How to schedule nightly SQLite ingest, daily log rotation, and cron health checks using openclaw cron or system cron."
---

# Cron Setup

The event-log pipeline runs four scheduled jobs:

| Job               | Frequency                         | Script                                  |
| ----------------- | --------------------------------- | --------------------------------------- |
| Cron health check | Every 30 min                      | `scripts/cron-log-db.ts check-failures` |
| Log ingest        | Nightly (recommended 02:00)       | `scripts/log-ingest.ts`                 |
| Log rotation      | Daily (recommended 03:00)         | `scripts/log-rotate.ts`                 |
| Memory synthesis  | Weekly (recommended Sunday 01:00) | `scripts/memory-synthesize.ts`          |

Run ingest _before_ rotation so the database is current before old JSONL files are compressed.

The `cron-wrap.sh` wrapper is recommended for all shell-based jobs. It handles PID locking (preventing overlapping runs), signal traps for clean shutdown, optional timeouts, and automatic `cron-log.db` start/end recording. See [Cron Wrapper Script](cron-wrap.md) and [Cron Log Database](cron-log-db.md) for details.

---

## Option A — OpenClaw Cron

If you use OpenClaw's built-in cron system, add all jobs to your cron store as `agentTurn` payloads. The prompts below use `cron-wrap.sh` for shell jobs to get PID locking and DB logging automatically.

### Health check (every 30 minutes)

Detects persistent failures (3+ errors in 6 hours) and surfaces stuck runs.

```json
{
  "id": "cron-health-check",
  "schedule": { "kind": "cron", "expr": "*/30 * * * *" },
  "payload": {
    "kind": "agentTurn",
    "message": "Health check:\n1. Run: bun scripts/cron-log-db.ts cleanup-stale\n2. Run: bun scripts/cron-log-db.ts check-failures --window-hours 6 --threshold 3\n3. If hasAlert=true, send a concise failure alert listing affected jobs and error counts\n4. Run: bun scripts/cron-log-db.ts query --status running to surface stuck jobs\n5. If nothing notable, reply HEARTBEAT_OK",
    "deliver": false,
    "lightContext": true
  },
  "failureAlert": { "after": 3 }
}
```

### Nightly ingest

```json
{
  "id": "event-log-ingest",
  "schedule": { "kind": "cron", "expr": "0 2 * * *" },
  "payload": {
    "kind": "agentTurn",
    "message": "Run event log ingest:\nbash scripts/cron-wrap.sh --job event-log-ingest -- bun scripts/log-ingest.ts --verbose\nReport the JSON summary and any errors.",
    "deliver": true
  },
  "delivery": { "mode": "announce" },
  "failureAlert": { "after": 3 }
}
```

### Daily rotation

```json
{
  "id": "event-log-rotate",
  "schedule": { "kind": "cron", "expr": "0 3 * * *" },
  "payload": {
    "kind": "agentTurn",
    "message": "Run event log rotation:\nbash scripts/cron-wrap.sh --job event-log-rotate --timeout 600 -- bun scripts/log-rotate.ts --archive-db --verbose\nReport the JSON summary and any errors.",
    "deliver": true
  },
  "delivery": { "mode": "announce" },
  "failureAlert": { "after": 3 }
}
```

### Weekly memory synthesis

Reads the past week of daily notes (`memory/YYYY-MM-DD.md`) and distills durable preferences,
patterns, and mistakes into the learnings database (same DB used by `learnings_record` /
`learnings_query`).

```json
{
  "id": "memory-synthesize",
  "schedule": { "kind": "cron", "expr": "0 1 * * 0" },
  "payload": {
    "kind": "agentTurn",
    "message": "Run memory synthesis:\nbash scripts/cron-wrap.sh --job memory-synthesize -- bun scripts/memory-synthesize.ts --verbose\nReport the summary.",
    "deliver": true
  },
  "delivery": { "mode": "announce" },
  "failureAlert": { "after": 2 }
}
```

Adjust the paths to match your deployment. Use `pnpm exec tsx` if `tsx` is not on `PATH`.

---

## Option B — System Cron (`crontab -e`)

The entries below use `cron-wrap.sh` for PID locking and DB logging. Replace `/home/user/openclaw` with the actual repository root.

```cron
# Cron health check: every 30 minutes
*/30 * * * * cd /home/user/openclaw && bun scripts/cron-log-db.ts cleanup-stale >> /tmp/cron-health.out 2>&1 && bun scripts/cron-log-db.ts check-failures >> /tmp/cron-health.out 2>&1

# Event-log: nightly ingest at 02:00 (with PID lock + DB logging)
7 2 * * * cd /home/user/openclaw && bash scripts/cron-wrap.sh --job event-log-ingest -- bun scripts/log-ingest.ts --verbose >> /tmp/cron-ingest.out 2>&1

# Event-log: daily rotation at 03:00 (with PID lock, 10-minute timeout)
7 3 * * * cd /home/user/openclaw && bash scripts/cron-wrap.sh --job event-log-rotate --timeout 600 -- bun scripts/log-rotate.ts --archive-db --verbose >> /tmp/cron-rotate.out 2>&1

# Memory synthesis: weekly on Sunday at 01:00
7 1 * * 0 cd /home/user/openclaw && bash scripts/cron-wrap.sh --job memory-synthesize -- bun scripts/memory-synthesize.ts --verbose >> /tmp/cron-memory-synth.out 2>&1
```

---

## Option C — Systemd Timers

Create unit pairs under `~/.config/systemd/user/`:

### `openclaw-cron-health.service`

```ini
[Unit]
Description=OpenClaw cron health check

[Service]
Type=oneshot
WorkingDirectory=/home/user/openclaw
ExecStart=bun scripts/cron-log-db.ts cleanup-stale
ExecStart=bun scripts/cron-log-db.ts check-failures
StandardOutput=append:/tmp/openclaw-cron-health.log
StandardError=inherit
```

### `openclaw-cron-health.timer`

```ini
[Unit]
Description=Run OpenClaw cron health check every 30 minutes

[Timer]
OnBootSec=1min
OnUnitActiveSec=30min
Persistent=true

[Install]
WantedBy=timers.target
```

### `openclaw-log-ingest.service`

```ini
[Unit]
Description=OpenClaw event-log nightly ingest

[Service]
Type=oneshot
WorkingDirectory=/home/user/openclaw
ExecStart=bash scripts/cron-wrap.sh --job event-log-ingest -- bun scripts/log-ingest.ts --verbose
StandardOutput=append:/tmp/openclaw-log-ingest.log
StandardError=inherit
```

### `openclaw-log-ingest.timer`

```ini
[Unit]
Description=Run OpenClaw event-log ingest nightly

[Timer]
OnCalendar=*-*-* 02:07:00
Persistent=true

[Install]
WantedBy=timers.target
```

### `openclaw-log-rotate.service`

```ini
[Unit]
Description=OpenClaw event-log daily rotation

[Service]
Type=oneshot
WorkingDirectory=/home/user/openclaw
ExecStart=bash scripts/cron-wrap.sh --job event-log-rotate --timeout 600 -- bun scripts/log-rotate.ts --archive-db --verbose
StandardOutput=append:/tmp/openclaw-log-rotate.log
StandardError=inherit
```

### `openclaw-log-rotate.timer`

```ini
[Unit]
Description=Run OpenClaw event-log rotation daily

[Timer]
OnCalendar=*-*-* 03:07:00
Persistent=true

[Install]
WantedBy=timers.target
```

### `openclaw-memory-synthesize.service`

```ini
[Unit]
Description=OpenClaw weekly memory synthesis

[Service]
Type=oneshot
WorkingDirectory=/home/user/openclaw
ExecStart=bash scripts/cron-wrap.sh --job memory-synthesize -- bun scripts/memory-synthesize.ts --verbose
StandardOutput=append:/tmp/openclaw-memory-synth.log
StandardError=inherit
```

### `openclaw-memory-synthesize.timer`

```ini
[Unit]
Description=Run OpenClaw memory synthesis weekly

[Timer]
OnCalendar=Sun *-*-* 01:07:00
Persistent=true

[Install]
WantedBy=timers.target
```

Enable and start:

```bash
systemctl --user daemon-reload
systemctl --user enable --now openclaw-cron-health.timer
systemctl --user enable --now openclaw-log-ingest.timer
systemctl --user enable --now openclaw-log-rotate.timer
systemctl --user enable --now openclaw-memory-synthesize.timer

# Verify
systemctl --user list-timers | grep openclaw
```

---

## Verifying a Run

After the first scheduled execution, confirm rows were inserted and the cron log was written:

```bash
# Row count in the event-log database
sqlite3 data/logs/structured.db "SELECT count(*) FROM structured_logs;"

# Confirm compressed archives exist
ls -lh data/logs/*.jsonl.gz 2>/dev/null
ls -lh data/logs/archive/*.db 2>/dev/null

# Check cron log DB for today's runs
bun scripts/cron-log-db.ts query --from "$(date -Idate)"

# Check for any failure bursts
bun scripts/cron-log-db.ts check-failures
```

---

## Manual One-Off Run

Trigger any job immediately using the wrapper:

```bash
# Ingest now (with PID lock + DB logging)
bash scripts/cron-wrap.sh --job event-log-ingest -- bun scripts/log-ingest.ts --verbose

# Rotate now (dry-run first)
bun scripts/log-rotate.ts --dry-run --verbose
bash scripts/cron-wrap.sh --job event-log-rotate -- bun scripts/log-rotate.ts --archive-db --verbose

# Health check now
bun scripts/cron-log-db.ts cleanup-stale
bun scripts/cron-log-db.ts check-failures
```

---

## Recommended Configuration Reference

| Setting               | Recommended Value       | Notes                                         |
| --------------------- | ----------------------- | --------------------------------------------- |
| Health check schedule | `*/30 * * * *`          | Every 30 min                                  |
| Failure threshold     | `3` errors in `6` hours | Tune via `--threshold` / `--window-hours`     |
| Stale run max age     | `2` hours               | Tune via `--max-age-hours`                    |
| Ingest schedule       | `7 2 * * *`             | 02:07 local time, nightly (off the :00 mark)  |
| Rotation schedule     | `7 3 * * *`             | 03:07 local time, daily (after ingest)        |
| Rotation timeout      | `600` seconds           | 10 min; adjust for large repos                |
| Rotation threshold    | `52428800` (50 MB)      | Adjust down if disk is tight                  |
| Archives to keep      | `3`                     | ~3 days of per-event history alongside the DB |
| Archive DB            | `--archive-db`          | Enable once DB grows beyond ~500 MB           |
| Memory synthesis      | `7 1 * * 0`             | Sunday 01:07 local time, weekly               |

## Related Documentation

- [Cron Log Database](cron-log-db.md) — Full reference for `scripts/cron-log-db.ts`
- [Cron Wrapper Script](cron-wrap.md) — Full reference for `scripts/cron-wrap.sh`
- [Database Ingest](log-ingest.md) — Event-log SQLite ingest reference
- [Log Rotation](log-rotate.md) — Rotation and archiving reference
