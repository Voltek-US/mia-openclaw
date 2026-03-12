---
summary: "Mia heartbeat — proactive task generation, queue processing, housekeeping"
---

# HEARTBEAT.md

## Three-Phase Heartbeat (every 10 min)

### Phase 1 — Proactive Scan (generate new tasks)

Before processing the queue, look for new work to track:

1. Check what's already queued: `task-list.sh active`
2. Cron job health — any with `consecutiveErrors > 0`? Add a `system` task to fix it
3. Today's daily notes — any untracked action items, promises, or follow-ups? Queue them
4. Recent messages — any `buy:/shopping:/remind me/add task:` triggers not yet queued? Add them
5. Overdue tasks (pending + due >12h ago) → bump to priority 9

**Task types:** `reminder`, `shopping`, `household`, `content`, `system`, `follow_up`, `custom`
**Priorities:** 1–3 low, 4–6 normal, 7–8 high, 9–10 urgent

### Phase 2 — Process Queue

Run `heartbeat-tick.sh` and act on results:

- **pending_tasks** → `task-start.sh` → execute → `task-complete.sh` or `task-fail.sh`
  - `auto_resolve=1` + routine → complete immediately
  - `shopping` → confirm added, don't buy
  - `system` → investigate/fix or escalate
- **unnotified_errors** → auth = immediate Telegram alert; batch others if 3+
- **recurring_to_reschedule** → `task-reschedule.sh` for each
- **stale_failed** → report count

### Phase 3 — Housekeeping (autonomous)

- Clear bought shopping items: `shopping.sh clear`
- If 3+ urgent tasks due today → send Telegram summary to Ledi
- Log one-line heartbeat summary to daily notes

### Phase 4 — Context Usage Monitor

Check active Telegram sessions for context window saturation:

1. `sessions_list` with `activeMinutes: 120`, `messageLimit: 0`
2. For each session where `channel == "telegram"`:
   - Compute `pct = totalTokens / contextTokens * 100`
   - If `pct >= 80` AND session key NOT in `~/.openclaw/ledi/context-alerted.json`:
     - Send Telegram alert: `⚠️ Context window at {pct}% ({totalTokens}/{contextTokens} tokens). Consider /compact or /new to start fresh.`
     - Add session key to `~/.openclaw/ledi/context-alerted.json`
   - If `pct >= 95` (critical): alert even if already alerted at 80%
3. Clean up `context-alerted.json` — remove entries for sessions no longer in the active list

**Alert format:** `⚠️ Tokens: {used}/{max} ({pct}%) — context window getting full. Use /compact or /new.`

### Quiet Hours (23:00–07:00 ET)

Only Phase 2 errors + auth alerts + Phase 4 critical (≥95%) alerts. Skip Phase 1 and Phase 3.

## Task Scripts (`~/.openclaw/ledi/bin/`)

| Script               | Purpose                                                          |
| -------------------- | ---------------------------------------------------------------- | ----------- | ------ | ------ |
| `heartbeat-tick.sh`  | Scan queue, fail stale, return pending tasks                     |
| `task-add.sh`        | Add task: `<type> <prompt> [pri] [when] [cron] [auto] [retries]` |
| `task-start.sh`      | Mark task running: `<id>`                                        |
| `task-complete.sh`   | Mark task done: `<id> [output]`                                  |
| `task-fail.sh`       | Fail with retry: `<id> <err_type> [message]`                     |
| `task-list.sh`       | List tasks: `[status] [type]`                                    |
| `task-reschedule.sh` | Clone recurring task for next run: `<id>`                        |
| `shopping.sh`        | Shopping: `add                                                   | list        | bought | clear` |
| `errors-list.sh`     | List unresolved errors: `[--mark-notified]`                      |
| `errors-resolve.sh`  | Resolve errors: `<id>                                            | --task <id> | --all` |
| `init-db.sh`         | Schema init/migration                                            |

## Adhoc Triggers (act immediately on receipt)

| Trigger phrase               | Action                                                |
| ---------------------------- | ----------------------------------------------------- |
| `content idea: ...`          | `task-add.sh content "<idea>" 6`                      |
| `add task: ...`              | `task-add.sh` with appropriate type and priority      |
| `buy: ...` / `shopping: ...` | `shopping.sh add "<item>"`                            |
| `remind me [when] to ...`    | `task-add.sh reminder "<prompt>" 7 "<scheduled_for>"` |
| `show me my tasks`           | `task-list.sh` + list active cron jobs                |
| `what failed?`               | `errors-list.sh` + check cron jobs for errors         |

## DB Location

`~/.openclaw/ledi/mia.sqlite` — tables: `task_queue`, `errors`, `action_log`

## Stay Silent When

- Phase 1 added nothing AND heartbeat-tick returns `HEARTBEAT_OK`
- Quiet hours AND no errors

## Notify When

- Auth errors (immediate)
- 3+ unnotified errors (batch)
- 3+ urgent tasks due same day
- Any cron job with 3+ consecutive errors
