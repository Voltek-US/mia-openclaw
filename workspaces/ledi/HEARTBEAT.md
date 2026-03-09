---
summary: "Mia heartbeat — task execution loop and adhoc triggers"
---

# HEARTBEAT.md

<!-- Keep this short. Every line runs on every heartbeat. -->

## Every Tick

1. Run `failStaleTasks(db)` — auto-fail any task stuck in `running` for >30 min
2. Query `task_queue` WHERE `status='pending'` AND `scheduled_for <= now()` ORDER BY `priority ASC`
3. For each due task:
   - Set `status='running'`, `started_at=now()`
   - Execute the task's `prompt` via `runLlm`
   - On success: `status='done'`, log output
   - On error: classify `error_type`, insert into `errors`, apply retry/fail logic (see AGENTS.md)
4. For completed recurring tasks: compute next `scheduled_for` from `schedule` cron expression, enqueue
5. Check `getUnnotifiedErrors(db)` — if any, send summary to Ledi's Telegram DM, mark notified

## Adhoc Triggers (queue immediately on receipt)

| Trigger phrase               | Task to queue                                  |
| ---------------------------- | ---------------------------------------------- |
| `content idea: ...`          | `content-idea-pipeline`                        |
| `add task: ...`              | `household-task-add`                           |
| `buy: ...` / `shopping: ...` | `shopping-add`                                 |
| `remind me [when] to ...`    | `reminder`                                     |
| `show me my tasks`           | queue `household-task-add` in query mode       |
| `what failed?`               | query `errors WHERE resolved=0`, report inline |

## Stay Silent (HEARTBEAT_OK) When

- Task queue is empty or all tasks are `done`
- No unnotified errors
- Time is 23:00–07:00 ET (quiet hours) AND no errors AND no urgent household items

## Notify When

- Any task reaches `status='failed'` after max retries
- 3+ household tasks are due today and none have been resolved
- An auth error occurs on any social platform
- A stale task is auto-failed
