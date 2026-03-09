---
title: "Self-Improvement Infrastructure — Overview"
summary: "Architecture overview of the agent self-improvement system: SQL learnings store, agent tools, automated review councils, tiered test runners, and the post-tool-use error-capture hook."
---

# Self-Improvement Infrastructure

This section documents the self-improvement infrastructure added to OpenClaw agents. It gives agents a persistent SQL-backed memory for corrections and insights, automated daily review councils, a tiered test schedule, and a hook that passively captures error patterns from tool output.

## At a Glance

| Component              | Location                                     | Purpose                                                            |
| ---------------------- | -------------------------------------------- | ------------------------------------------------------------------ |
| SQL learnings store    | `src/agents/tools/learnings-store-sqlite.ts` | Three-table SQLite DB: learnings, error patterns, feature requests |
| Agent tools            | `src/agents/tools/learnings-tool.ts`         | `learnings_record` + `learnings_query` for agent use               |
| Post-tool-use hook     | `scripts/hooks/scan-tool-output.ts`          | Passively captures error signatures from tool output               |
| Platform health review | `scripts/review-platform-health.ts`          | Daily cron: error frequency + correction summary                   |
| Security review        | `scripts/review-security.ts`                 | Daily cron: auth errors + `pnpm audit` analysis                    |
| Innovation scout       | `scripts/review-innovation.ts`               | Daily cron: surfaces open feature requests + insights              |
| Tier-1 test runner     | `scripts/test-tier1.ts`                      | Nightly: `pnpm test` (no LLM calls, free)                          |
| Tier-2 test runner     | `scripts/test-tier2.ts`                      | Weekly: live LLM calls (low cost)                                  |
| Tier-3 test runner     | `scripts/test-tier3.ts`                      | Weekly: full e2e including messaging round-trips                   |
| AGENTS.md template     | `docs/reference/templates/AGENTS.md`         | Self-Improvement section instructs agents on when to record        |

## How Data Flows

```
Agent session (private/direct)
  ├─ learnings_query  → reads corrections/insights from learnings.sqlite
  └─ learnings_record → writes correction, insight, or feature_request

Claude Code tool calls (any)
  └─ PostToolUse hook (scan-tool-output.ts)
       └─ error pattern detected → upserted into error_patterns table

Nightly/weekly cron scripts
  ├─ test-tier1.ts  → pnpm test  → failure alert via openclaw message send
  ├─ test-tier2.ts  → live LLM tests
  └─ test-tier3.ts  → full e2e tests

Daily review crons (read learnings.sqlite)
  ├─ review-platform-health.ts → summary to REVIEW_CHANNEL
  ├─ review-security.ts        → security analysis to REVIEW_CHANNEL
  └─ review-innovation.ts      → proposals to REVIEW_CHANNEL
```

## Database Location

The learnings database lives alongside the sessions database for each agent:

```
~/.openclaw/agents/<agentId>/sessions/learnings.sqlite
```

The default agent (`main`) path:

```
~/.openclaw/agents/main/sessions/learnings.sqlite
```

## Pages in This Section

- [Learnings Database](learnings-db.md) — Schema, operations, and direct SQL access
- [Agent Tools](agent-tools.md) — `learnings_record` and `learnings_query` tool reference
- [Post-Tool-Use Hook](hook.md) — Passive error pattern capture
- [Review Councils](review-councils.md) — Daily review cron scripts reference
- [Tiered Testing](tiered-testing.md) — Nightly and weekly test cron reference
- [Cron Setup](cron-setup.md) — Scheduling all jobs (system crontab or OpenClaw cron)
