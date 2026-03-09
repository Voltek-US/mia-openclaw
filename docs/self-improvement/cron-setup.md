---
title: "Cron Setup — Self-Improvement Automation"
summary: "How to schedule the six self-improvement jobs: review councils and tiered test runners, using system crontab or OpenClaw cron."
---

# Cron Setup

The self-improvement pipeline has six scheduled jobs:

| Job                    | Schedule       | Script                              |
| ---------------------- | -------------- | ----------------------------------- |
| Tier-1 tests           | Nightly 02:00  | `scripts/test-tier1.ts`             |
| Tier-2 tests           | Sunday 03:00   | `scripts/test-tier2.ts`             |
| Tier-3 tests           | Saturday 04:00 | `scripts/test-tier3.ts`             |
| Platform health review | Daily 04:02    | `scripts/review-platform-health.ts` |
| Security review        | Daily 05:03    | `scripts/review-security.ts`        |
| Innovation scout       | Daily 06:07    | `scripts/review-innovation.ts`      |

Test runners fire before review councils each day so the health review reflects any new error patterns caught overnight.

---

## Prerequisites

Set these environment variables before the crons fire. Add them to `~/.profile` or `/etc/environment`:

```bash
export REVIEW_CHANNEL="<your-channel-id>"   # Telegram user ID, Discord channel, etc.
export TEST_CHANNEL="<your-channel-id>"     # Can be the same as REVIEW_CHANNEL
```

Tier-2 and Tier-3 tests require API keys in environment (see [testing docs](/testing)).

---

## Option A — System Crontab

```bash
crontab -e
```

Paste:

```cron
# Self-improvement: tier-1 tests (nightly 02:00, no LLM)
0 2 * * * cd /home/openclaw/openclaw && bun scripts/test-tier1.ts --verbose >> /tmp/test-tier1.log 2>&1

# Self-improvement: tier-2 tests (weekly Sunday 03:00, live LLM)
0 3 * * 0 cd /home/openclaw/openclaw && bun scripts/test-tier2.ts --verbose >> /tmp/test-tier2.log 2>&1

# Self-improvement: tier-3 tests (weekly Saturday 04:00, full e2e)
0 4 * * 6 cd /home/openclaw/openclaw && bun scripts/test-tier3.ts --verbose >> /tmp/test-tier3.log 2>&1

# Self-improvement: platform health review (daily 04:02)
2 4 * * * cd /home/openclaw/openclaw && bun scripts/review-platform-health.ts --verbose >> /tmp/review-platform-health.log 2>&1

# Self-improvement: security review (daily 05:03)
3 5 * * * cd /home/openclaw/openclaw && bun scripts/review-security.ts --verbose >> /tmp/review-security.log 2>&1

# Self-improvement: innovation scout (daily 06:07)
7 6 * * * cd /home/openclaw/openclaw && bun scripts/review-innovation.ts --verbose >> /tmp/review-innovation.log 2>&1
```

Replace `/home/openclaw/openclaw` with your actual repo root. Verify with `crontab -l`.

---

## Option B — OpenClaw Cron (agent-triggered)

The OpenClaw cron system fires agent prompts, not shell commands. Use it to have the gateway agent run the scripts on schedule:

```bash
openclaw cron add \
  --name "review-platform-health" \
  --cron "2 4 * * *" \
  --message "Run the platform health review: bun scripts/review-platform-health.ts --verbose" \
  --announce

openclaw cron add \
  --name "review-security" \
  --cron "3 5 * * *" \
  --message "Run the security review: bun scripts/review-security.ts --verbose" \
  --announce

openclaw cron add \
  --name "review-innovation" \
  --cron "7 6 * * *" \
  --message "Run the innovation scout: bun scripts/review-innovation.ts --verbose" \
  --announce

openclaw cron add \
  --name "test-tier1" \
  --cron "0 2 * * *" \
  --message "Run the nightly tier-1 tests: bun scripts/test-tier1.ts --verbose" \
  --announce

openclaw cron add \
  --name "test-tier2" \
  --cron "0 3 * * 0" \
  --message "Run the weekly tier-2 live LLM tests: bun scripts/test-tier2.ts --verbose" \
  --announce

openclaw cron add \
  --name "test-tier3" \
  --cron "0 4 * * 6" \
  --message "Run the weekly tier-3 full e2e tests: bun scripts/test-tier3.ts --verbose" \
  --announce
```

List registered jobs:

```bash
openclaw cron list
```

---

## Verifying a Run

After the first scheduled execution, check the log files and confirm the database was updated:

```bash
# Last platform health run
tail -20 /tmp/review-platform-health.log

# Last test run
tail -20 /tmp/test-tier1.log

# Error patterns captured so far
sqlite3 ~/.openclaw/agents/main/sessions/learnings.sqlite \
  "SELECT pattern, count FROM error_patterns ORDER BY count DESC LIMIT 10;"
```

---

## Manual One-Off Runs

Trigger any job immediately:

```bash
bun scripts/review-platform-health.ts --dry-run --verbose
bun scripts/review-security.ts --dry-run --verbose
bun scripts/review-innovation.ts --dry-run --verbose

bun scripts/test-tier1.ts --verbose
```

Use `--dry-run` for the review scripts to print the report without sending a message.

---

## Recommended Configuration Reference

| Setting          | Recommended Value | Notes                         |
| ---------------- | ----------------- | ----------------------------- |
| Tier-1 schedule  | `0 2 * * *`       | Nightly before reviews        |
| Platform health  | `2 4 * * *`       | After tier-1, offset from :00 |
| Security review  | `3 5 * * *`       | Offset from :00               |
| Innovation scout | `7 6 * * *`       | Offset from :00               |
| Tier-2 schedule  | `0 3 * * 0`       | Sunday morning                |
| Tier-3 schedule  | `0 4 * * 6`       | Saturday morning              |
| Log dir          | `/tmp/`           | Rotate or redirect as needed  |
