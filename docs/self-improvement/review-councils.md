---
title: "Review Councils"
summary: "Daily automated review cron scripts: platform health, security analysis, and innovation scouting — each reading the learnings database and delivering a summary via messaging."
---

# Review Councils

Three daily cron scripts perform automated self-reviews and deliver summaries to a messaging channel. Each reads the SQL learnings database and produces a structured report. Failures are reported proactively via `openclaw message send`.

## Environment Variables

| Variable         | Required | Description                                                                       |
| ---------------- | -------- | --------------------------------------------------------------------------------- |
| `REVIEW_CHANNEL` | yes      | Messaging target for report delivery (Telegram user ID, Discord channel ID, etc.) |
| `OPENCLAW_HOME`  | no       | Override for `~/.openclaw` base path                                              |

Set both in your environment before the crons fire:

```bash
export REVIEW_CHANNEL="123456789"      # Telegram user ID
export REVIEW_CHANNEL="general"        # Discord channel name
```

---

## Platform Health Review

**File:** `scripts/review-platform-health.ts`
**Schedule:** Daily at 04:02
**Log:** `/tmp/review-platform-health.log`

Reads the learnings database and reports:

- **Error patterns** seen 3+ times in the last 7 days
- **Recent corrections** (last 10 by created_at)
- **Open feature requests** count

### Usage

```bash
bun scripts/review-platform-health.ts [--dry-run] [--verbose]
```

| Flag        | Description                          |
| ----------- | ------------------------------------ |
| `--dry-run` | Print report to stdout; skip sending |
| `--verbose` | Log progress details                 |

### Example Output

```
*Platform Health Review*
Date: 2026-03-09

Error patterns (7d, ≥3 hits): 2
  • ENOENT: no such file or directory — 7 hits
  • ECONNREFUSED 127.0.0.1:18789 — 4 hits

Recent corrections: 3
  • Always use heredoc for multi-line gh comments
  • Never run git push --force on main
  • Use pnpm exec tsx for TypeScript scripts, not ts-node

Open feature requests: 5
  • Auto-resolve bot PR review conversations
  • Auto-retry on rate limit
  • Nightly prompt sync check
```

---

## Security Review

**File:** `scripts/review-security.ts`
**Schedule:** Daily at 05:03
**Log:** `/tmp/review-security.log`

Multi-perspective analysis covering four viewpoints:

| Perspective  | What it checks                                                                     |
| ------------ | ---------------------------------------------------------------------------------- |
| Offensive    | Auth/permission error patterns from the last 7 days (401, 403, unauthorized, etc.) |
| Defensive    | `pnpm audit --json` — critical and high severity advisories                        |
| Data privacy | PII-related error patterns (pii, email, phone, personal, leak, exfil)              |
| Operational  | Actionable items: token rotation, advisory fixes                                   |

### Usage

```bash
bun scripts/review-security.ts [--dry-run] [--verbose]
```

### Example Output

```
*Security Review*
Date: 2026-03-09

Offensive: auth/permission errors in last 7d:
  • 403 forbidden — 3 hits
  • invalid token — 2 hits

Defensive: audit: 0 critical, 1 high, 3 moderate, 8 low

Data privacy: PII-related patterns: 0

Operational: action items
  • Rotate or inspect tokens referenced in auth errors
  • Fix 1 high npm advisory
```

---

## Innovation Scout

**File:** `scripts/review-innovation.ts`
**Schedule:** Daily at 06:07
**Log:** `/tmp/review-innovation.log`

Surfaces open feature requests and recent insights from the learnings database, proposes the top 3, and invites accept/reject replies.

### Usage

```bash
bun scripts/review-innovation.ts [--dry-run] [--verbose]
```

### Example Output

```
*Innovation Scout*
Date: 2026-03-09

Top proposals (3):
1. [feature_request] Auto-resolve bot PR review conversations
2. [feature_request] Auto-retry on rate limit
3. [insight] pnpm test:live requires CLAWDBOT_LIVE_TEST=1, not just LIVE=1

Reply 'accept N' or 'reject N' for each idea.

Open feature requests: 5 total
```

---

## Manual One-Off Run

Run any review at any time:

```bash
bun scripts/review-platform-health.ts --dry-run --verbose
bun scripts/review-security.ts --dry-run --verbose
bun scripts/review-innovation.ts --dry-run --verbose
```

`--dry-run` prints the report to stdout without sending a message.
