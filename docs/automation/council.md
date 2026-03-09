---
title: "Business Intelligence Council"
description: "Nightly AI-powered analysis of your business signals — expert personas, ranked recommendations, and a CLI for deeper exploration."
---

The BI Council syncs data from your business tools, runs multiple expert LLM personas in parallel, synthesizes their findings into ranked recommendations, and delivers a nightly digest to your messaging channel.

## Architecture

```
Data sync (cron)      Expert analysis (parallel)      Synthesis
─────────────────     ────────────────────────────     ──────────────
chat  (3h)  ──┐       GrowthStrategist                 Synthesizer
crm   (4h)  ──┤  ──>  RevenueGuardian    ──>  findings ──>  ranked
projects (4h)─┤       OperationsAnalyst              recommendations
social (1d) ──┤       ContentStrategist
financial   ──┘       MarketAnalyst
                      CFO
```

All data is stored locally in `~/.openclaw/intelligence/bi.sqlite`.

## Setup

### 1. Configure environment variables

Add these to your `~/.profile` (or shell rc):

```sh
# Required for digest delivery
export COUNCIL_CHANNEL="@yourname"    # or a group/channel ID

# Optional tuning
export COUNCIL_LOOKBACK_DAYS=3        # days of signal history per run

# Data source tokens (add the ones you use)
export COUNCIL_CHAT_TOKEN="xoxb-..."          # Slack / Discord bot token
export COUNCIL_CHAT_ENDPOINT="https://..."    # API base URL (if needed)
export COUNCIL_CHAT_CHANNEL="C12345678"       # Channel/room ID to pull from

export COUNCIL_CRM_TOKEN="pat-..."            # HubSpot / Pipedrive / Salesforce token
export COUNCIL_CRM_ENDPOINT="https://..."     # CRM base URL (if needed)

export COUNCIL_PROJECTS_TOKEN="lin_api_..."   # Linear / Jira / GitHub token
export COUNCIL_PROJECTS_ENDPOINT="https://..." # PM base URL (if needed)
export COUNCIL_PROJECTS_TEAM="team-id"        # Team / workspace ID

export COUNCIL_SOCIAL_TOKEN="..."             # Twitter/X / LinkedIn / Buffer token
export COUNCIL_SOCIAL_ENDPOINT="https://..."  # Social API base URL (if needed)

export COUNCIL_FINANCIAL_FILE="~/exports/financials.csv"  # Path to export file
```

### 2. Fill in your API calls

Each sync script has a `fetchRecords()` function with detailed TODO comments and examples for common platforms. Edit the relevant scripts:

| Source    | Script                                                                       | Common platforms               |
| --------- | ---------------------------------------------------------------------------- | ------------------------------ |
| Team chat | [scripts/council-sync-chat.ts](../../scripts/council-sync-chat.ts)           | Slack, Discord, MS Teams       |
| Projects  | [scripts/council-sync-projects.ts](../../scripts/council-sync-projects.ts)   | Linear, Jira, GitHub Issues    |
| CRM       | [scripts/council-sync-crm.ts](../../scripts/council-sync-crm.ts)             | HubSpot, Pipedrive, Salesforce |
| Social    | [scripts/council-sync-social.ts](../../scripts/council-sync-social.ts)       | Twitter/X, LinkedIn, YouTube   |
| Financial | [scripts/council-sync-financial.ts](../../scripts/council-sync-financial.ts) | QuickBooks CSV, Stripe, Xero   |

Sync scripts return `[]` gracefully when their token is not set, so you can add sources incrementally without breaking the council run.

### 3. Install cron jobs

Run `crontab -e` and add:

```crontab
# BI Council — team chat (every 3 hours)
0 */3 * * * cd /path/to/openclaw && bun scripts/council-sync-chat.ts >> /tmp/council-chat.log 2>&1

# BI Council — projects (every 4 hours)
0 */4 * * * cd /path/to/openclaw && bun scripts/council-sync-projects.ts >> /tmp/council-projects.log 2>&1

# BI Council — CRM (every 4 hours, offset 30 minutes)
30 */4 * * * cd /path/to/openclaw && bun scripts/council-sync-crm.ts >> /tmp/council-crm.log 2>&1

# BI Council — social analytics (daily at 01:00)
0 1 * * * cd /path/to/openclaw && bun scripts/council-sync-social.ts >> /tmp/council-social.log 2>&1

# BI Council — nightly council run (02:30, after all syncs complete)
30 2 * * * COUNCIL_CHANNEL="@yourname" cd /path/to/openclaw && bun scripts/council-run.ts >> /tmp/council-run.log 2>&1
```

Replace `/path/to/openclaw` with the actual repo path.

## Expert personas

Each expert sees only signals from their tagged data sources:

| Expert            | Tagged sources            | Focus                                   |
| ----------------- | ------------------------- | --------------------------------------- |
| GrowthStrategist  | chat, social, crm         | User acquisition, expansion, engagement |
| RevenueGuardian   | crm, financial            | Pipeline health, churn risk, ARR        |
| OperationsAnalyst | projects, chat, financial | Execution velocity, bottlenecks, costs  |
| ContentStrategist | social, chat              | Content performance, audience trends    |
| MarketAnalyst     | social, crm               | Competitive signals, market shifts      |
| CFO               | financial, crm            | Burn rate, runway, financial health     |

All experts run in parallel with `claude-opus-4-6`. A synthesis pass using `claude-sonnet-4-6` merges their findings into ranked recommendations.

## CLI reference

### Run the council

```sh
openclaw council run              # full run + deliver digest
openclaw council run --dry-run    # run but print digest to stdout only
openclaw council run --verbose    # verbose logging
openclaw council run --lookback 7 # use 7 days of signal history
```

### Check status

```sh
openclaw council status           # last run summary
openclaw council status --json    # JSON output
```

### Browse recommendations

```sh
openclaw council recommendations                    # latest run, top 10
openclaw council recs --limit 20                    # up to 20 recs
openclaw council recs --priority high               # high-priority only
openclaw council recs --run-id <run-id>             # specific run
openclaw council recs --json                        # JSON output
```

### Record feedback

```sh
openclaw council feedback 3 accept
openclaw council feedback 3 reject --notes "already doing this"
openclaw council feedback 3 defer  --notes "revisit next quarter"
```

Feedback is stored locally and feeds into future analysis context. You can change a decision at any time — the latest feedback wins.

### Trigger a manual sync

```sh
openclaw council sync                    # sync all sources
openclaw council sync --source crm       # sync CRM only
openclaw council sync --source chat --dry-run  # dry run
```

## Testing without API keys

Run a stub council (no LLM calls, no API keys needed):

```sh
COUNCIL_SKIP_LLM=1 bun scripts/council-run.ts --dry-run --verbose
```

This exercises the full pipeline (DB writes, digest formatting) with stub data, confirming everything is wired correctly before you add real API tokens.

## Digest format

The nightly digest looks like:

```
*BI Council — 2026-03-08*

*Expert Highlights*
• GrowthStrategist: Strong inbound from social campaign driving CRM inflow
• RevenueGuardian: 3 deals stalled >14 days — follow-up needed
• OperationsAnalyst: Sprint velocity down 20% — 2 blocked issues unresolved
• ContentStrategist: Video content 3× engagement vs text posts this week
• MarketAnalyst: Competitor pricing shift detected in CRM objections
• CFO: Burn increased 15% MoM — cloud infra primary driver

*Top Recommendations*
1. [HIGH] Unblock stalled pipeline — 3 deals at risk of going cold (domains: RevenueGuardian, GrowthStrategist)
2. [HIGH] Resolve sprint blockers — velocity impact affecting delivery (domains: OperationsAnalyst)
3. [MEDIUM] Double down on video content — 3× engagement multiplier (domains: ContentStrategist, GrowthStrategist)
...

Use `openclaw council recommendations` for full analysis
Use `openclaw council feedback <id> accept` to act on a recommendation
```

## Database location

All data is stored in `~/.openclaw/intelligence/bi.sqlite` (override with `COUNCIL_DB_DIR`).

Tables:

- `sync_data` — raw synced records from all sources (deduped by source+source_id)
- `expert_analyses` — per-run expert LLM outputs
- `recommendations` — synthesized ranked recommendations
- `recommendation_feedback` — your accept/reject/defer decisions

---

## Open Tasks — What Still Needs to Be Done

This section tracks what is fully built versus what requires your configuration. Work through the checklist in order.

### Step 1 — Wire up data sources (required)

Each sync script has a `fetchRecords()` stub that returns `[]` until you fill it in. The council works end-to-end once at least one source is wired.

**Chat** (`scripts/council-sync-chat.ts`)

- [ ] Set `COUNCIL_CHAT_TOKEN` in `~/.profile`
- [ ] Uncomment and adapt the `fetchRecords()` example for your platform (Slack, Discord, Teams)
- [ ] Set `COUNCIL_CHAT_CHANNEL` to the channel/room ID you want to pull
- [ ] Verify: `bun scripts/council-sync-chat.ts --dry-run --verbose`

**CRM** (`scripts/council-sync-crm.ts`)

- [ ] Set `COUNCIL_CRM_TOKEN` in `~/.profile`
- [ ] Uncomment and adapt the `fetchRecords()` example for your CRM (HubSpot, Pipedrive, Salesforce)
- [ ] Verify: `bun scripts/council-sync-crm.ts --dry-run --verbose`

**Project management** (`scripts/council-sync-projects.ts`)

- [ ] Set `COUNCIL_PROJECTS_TOKEN` in `~/.profile`
- [ ] Set `COUNCIL_PROJECTS_TEAM` to your team/workspace ID
- [ ] Uncomment and adapt the `fetchRecords()` example (Linear, Jira, GitHub Issues)
- [ ] Verify: `bun scripts/council-sync-projects.ts --dry-run --verbose`

**Social analytics** (`scripts/council-sync-social.ts`)

- [ ] Set `COUNCIL_SOCIAL_TOKEN` in `~/.profile`
- [ ] Uncomment and adapt the `fetchRecords()` example (Twitter/X, LinkedIn, YouTube)
- [ ] Verify: `bun scripts/council-sync-social.ts --dry-run --verbose`

**Financial** (`scripts/council-sync-financial.ts`)

- [ ] Export a CSV or JSON from your accounting/payments tool (QuickBooks, Stripe, Xero, Mercury)
- [ ] Set `COUNCIL_FINANCIAL_FILE` to the export path
- [ ] Verify: `COUNCIL_FINANCIAL_FILE=~/Downloads/export.csv bun scripts/council-sync-financial.ts --dry-run --verbose`

### Step 2 — Set the delivery channel (required for digest)

- [ ] Set `COUNCIL_CHANNEL` to the messaging target for nightly digests:
  ```sh
  export COUNCIL_CHANNEL="@yourname"   # DM to yourself
  # or a Slack channel ID, Discord channel ID, Telegram chat ID, etc.
  ```
- [ ] Add to `~/.profile` (or equivalent) so it persists across shells and cron

### Step 3 — Test end-to-end without LLM (recommended first)

- [ ] Run a stub council to verify the full pipeline:
  ```sh
  COUNCIL_SKIP_LLM=1 bun scripts/council-run.ts --dry-run --verbose
  ```
  Expected output: digest printed to stdout with stub findings. No channel delivery (--dry-run).

### Step 4 — Run a real council (requires Anthropic API key)

- [ ] Ensure `ANTHROPIC_API_KEY` is set (used by `shared/llm-router.js`)
- [ ] Run with at least one data source populated:
  ```sh
  bun scripts/council-run.ts --dry-run --verbose
  ```
- [ ] If satisfied, remove `--dry-run` to persist results and deliver the digest

### Step 5 — Install cron jobs

Copy the entries from [Step 3 above](#3-install-cron-jobs) into `crontab -e`. Recommended order:

- [ ] Data sync jobs (chat, projects, crm, social)
- [ ] Financial import reminder (or automated if your tool supports scheduled exports)
- [ ] Nightly council runner at 02:30 (after all syncs complete)

For PID locking and DB-backed logging, wrap each job with `scripts/cron-wrap.sh` (see [Cron Wrapper](/event-log/cron-wrap)):

```sh
# With cron-wrap (recommended — adds PID lock + cron-log.db entry):
30 2 * * * cd /path/to/openclaw && bash scripts/cron-wrap.sh --job council-run -- bun scripts/council-run.ts >> /tmp/council-run.log 2>&1
```

### Step 6 — Feedback loop

- [ ] After the first real run: `openclaw council recommendations` — browse ranked items
- [ ] Record decisions: `openclaw council feedback <id> accept|reject|defer --notes "..."`
- [ ] Feedback is persisted in `recommendation_feedback` and referenced in future digest context

### What is already built

Everything below is implemented and tested — no further work needed:

| Component                                                        | File(s)                                                                 |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------- |
| SQLite store (sync, analyses, recommendations, feedback)         | `src/intelligence/bi-store.ts`                                          |
| 6 expert personas                                                | `src/intelligence/experts/personas.ts`                                  |
| Parallel expert fan-out + synthesis + persistence                | `src/intelligence/council.ts`                                           |
| Digest formatting + channel delivery                             | `src/intelligence/delivery.ts`                                          |
| Nightly runner script                                            | `scripts/council-run.ts`                                                |
| Sync stub scripts with TODO examples                             | `scripts/council-sync-*.ts`                                             |
| CLI: `openclaw council run/status/recommendations/feedback/sync` | `src/cli/council-cli/`                                                  |
| Tests: store + council (stub mode)                               | `src/intelligence/bi-store.test.ts`, `src/intelligence/council.test.ts` |
