---
title: "Personal CRM"
summary: "Contact discovery, relationship scoring, personal tasks, follow-up nudges, and natural language queries — backed by a local SQLite database."
read_when:
  - You want to track contacts, interactions, and follow-ups
  - You want to use the crm_query agent tool
  - Setting up Gmail or Microsoft 365 integration for contact discovery
  - You want to schedule the daily CRM cron script
  - You want to generate and approve email drafts
---

# Personal CRM

OpenClaw's personal CRM is a relationship intelligence layer that lives entirely
on your device. It discovers contacts from Gmail or Microsoft 365, scores
relationships over time, surfaces nudges for who needs attention, and lets you
manage personal tasks alongside contact follow-ups.

It is designed for **all** types of relationships — friends, family, colleagues,
and professional contacts — not just business networking.

The CRM is accessible via:

- **`crm_query` agent tool** — ask anything in natural language from a direct conversation
- **`openclaw crm` CLI** — full command-line management
- **Daily cron script** — automatic sync, scoring, and digest delivery

## How it works

1. **Discovery** — email and calendar are scanned for new contacts. Noise filters
   remove mailing lists, no-reply addresses, large meetings, and internal domains.
   New candidates go through an interactive approval flow (or are auto-added once
   you have enough decisions to trust the signal).

2. **Scoring** — every contact gets a 0–100 relationship score. Score uses a
   cadence-aware model: a friend who hasn't heard from you in 15 days scores lower
   than a professional contact at the same silence interval, because friends are
   expected to interact more frequently.

3. **Nudges** — contacts whose score falls below a threshold, or whose last
   interaction exceeded their expected cadence, surface as nudges. Overdue personal
   tasks appear alongside them.

4. **Tasks** — personal tasks and follow-ups are first-class. A task can be
   attached to a contact ("Follow up with Alice about proposal") or standalone
   ("Pay quarterly taxes"). Both live in the same task list.

5. **LLM profiles** — the daily cron generates a short relationship profile for
   each contact based on recent context and interactions. Profiles are cached and
   regenerated when stale.

6. **Email drafts** — propose, review, and push draft replies to your mail provider
   (Gmail or Outlook) via the CLI. Drafts require `CRM_DRAFT_ENABLED=true` as an
   explicit safety gate — no email is ever sent automatically.

## Setup

### 1. Authorize an email/calendar provider

The CRM supports Gmail (via Google OAuth) and Microsoft 365 (via MSAL). You only
need one.

**Gmail:**

```bash
openclaw crm auth-gmail
```

This opens a browser OAuth flow. You need a Google Cloud project with the
Gmail API enabled. Download the OAuth client credentials JSON from the Google
Cloud Console and save it to `~/.openclaw/crm/gmail-credentials.json`, or
point to it with `CRM_GMAIL_CREDENTIALS`.

Required OAuth scopes: `gmail.readonly`, `gmail.compose`.

**Microsoft 365:**

```bash
openclaw crm auth-ms365
```

Requires `CRM_MS365_CLIENT_ID` and `CRM_MS365_CLIENT_SECRET` set in your
environment. Use `CRM_MS365_TENANT_ID=common` for personal Microsoft accounts.

Required Graph scopes: `Mail.ReadWrite`, `Calendars.Read`, `User.Read`.

Tokens are cached at `~/.openclaw/crm/gmail-token.json` and
`~/.openclaw/crm/ms365-token.json` respectively.

### 2. Run the first discovery

```bash
bun scripts/crm-discover.ts --verbose
```

Or via the CLI:

```bash
openclaw crm discover
```

This scans the last 7 days of email and calendar, filters noise, and walks you
through an interactive approval prompt for each new candidate:

```
alice@acme.com (Alice Nguyen) — email
  (a)pprove  (r)eject  (s)kip domain  (q)uit
```

- **a** — add the contact to the database
- **r** — reject and record the decision (informs auto-add learning)
- **s** — add the domain to your skip patterns so the whole domain is ignored going forward
- **q** — stop the session; unreviewed candidates are discarded

### 3. Schedule the daily sync

Register the cron script so it runs automatically every morning:

```bash
openclaw cron add \
  --name crm-daily \
  --schedule "0 7 * * *" \
  --script scripts/crm-daily.ts
```

Or run it manually at any time:

```bash
bun scripts/crm-daily.ts --dry-run --verbose
```

## Environment variables

| Variable                  | Default                                  | Description                                                        |
| ------------------------- | ---------------------------------------- | ------------------------------------------------------------------ |
| `CRM_DB_DIR`              | `~/.openclaw/crm`                        | Database directory                                                 |
| `CRM_PROVIDER`            | `auto`                                   | Email/calendar provider: `gmail`, `ms365`, or `auto`               |
| `CRM_GMAIL_CREDENTIALS`   | `~/.openclaw/crm/gmail-credentials.json` | Google OAuth client secrets                                        |
| `CRM_MS365_CLIENT_ID`     | _(required for MS365)_                   | Azure application client ID                                        |
| `CRM_MS365_CLIENT_SECRET` | _(required for MS365)_                   | Azure application client secret                                    |
| `CRM_MS365_TENANT_ID`     | `common`                                 | Azure tenant ID (`common` for personal accounts)                   |
| `CRM_INTERNAL_DOMAINS`    | _(empty)_                                | Comma-separated domains to exclude from discovery                  |
| `CRM_REPORT_CHANNEL`      | _(none)_                                 | OpenClaw channel for the daily digest (e.g. `telegram:direct:123`) |
| `CRM_DRAFT_ENABLED`       | `false`                                  | Safety gate: must be `true` to enable email draft creation         |
| `CRM_AUTO_MODE`           | `false`                                  | Auto-add all discovery candidates without interactive approval     |

## Agent tool

`crm_query` is registered automatically for **direct conversations only**. It is
suppressed in group chats and channels to protect personal data.

Supported queries:

| Query pattern                          | What it does                                                        |
| -------------------------------------- | ------------------------------------------------------------------- |
| `Tell me about Alice`                  | Contact profile, relationship summary, and recent interactions      |
| `Who at Acme Corp?`                    | All contacts whose company matches                                  |
| `Follow up with Bob in 2 weeks`        | Creates a follow-up task linked to Bob, due in 14 days              |
| `Remind me to call Alice in 3 days`    | Standalone personal task due in 3 days                              |
| `Add task Review proposal`             | Standalone task, due in 7 days by default                           |
| `My tasks` / `Todo`                    | All pending tasks (contact-linked + standalone), sorted by due date |
| `Done #12`                             | Mark task 12 as done                                                |
| `Cancel #5`                            | Cancel task 5                                                       |
| `Snooze #7 3 days`                     | Snooze task 7 for 3 days                                            |
| `Who needs attention?` / `Nudges`      | Contacts with declining scores + overdue tasks                      |
| `My friends` / `Colleagues` / `Family` | Contacts filtered by relationship type                              |
| `Stats`                                | Contact counts, task counts, and score distribution                 |

Duration words in queries (`in 2 weeks`, `in 1 month`) are parsed automatically.
Unrecognised queries fall back to a text search across names, emails, and companies.

## CLI reference

All commands are under `openclaw crm`.

### Auth

```bash
openclaw crm auth-gmail     # run Gmail + Google Calendar OAuth flow
openclaw crm auth-ms365     # run Microsoft 365 OAuth flow
```

### Contact management

```bash
openclaw crm contact list [--type friend|family|colleague|professional|other]
                          [--priority high|medium|low]
                          [--search QUERY]
                          [--json]

openclaw crm contact show <email>

openclaw crm contact edit <email> [--type TYPE]
                                  [--priority PRIORITY]
                                  [--cadence DAYS]   # override keep-in-touch cadence
                                  [--notes TEXT]
```

Adding contacts manually:

```bash
# Use 'contact edit' after adding via discover, or add via the agent tool.
# Manual addition via CLI: use 'contact edit' with any new email to create.
```

### Tasks and follow-ups

Tasks are unified across contact-linked follow-ups and standalone personal tasks.

```bash
openclaw crm task list [--type follow_up|task|reminder|birthday|event]
                       [--overdue]

openclaw crm task add --title "Call dentist" --due 7 --type task

openclaw crm task done <id>
openclaw crm task cancel <id>
openclaw crm task snooze <id> <days>
```

`--due` is in days from now (default: 7). Task types:

| Type        | Description                                |
| ----------- | ------------------------------------------ |
| `follow_up` | Contact follow-up (usually contact-linked) |
| `task`      | General personal task                      |
| `reminder`  | Time-sensitive reminder                    |
| `birthday`  | Birthday reminder                          |
| `event`     | Upcoming event                             |

### Nudges

```bash
openclaw crm nudges [--max N]    # default: 20 relationship nudges
```

Shows two sections:

- **Relationship nudges** — contacts whose score is low or who haven't heard from you beyond their cadence
- **Overdue tasks** — tasks past their due date

### Stats

```bash
openclaw crm stats [--json]
```

### Interactive discovery

```bash
openclaw crm discover [--dry-run] [--verbose] [--since ISO_DATE] [--provider gmail|ms365|auto]
```

Scans the last 7 days (override with `--since`) and walks you through the
interactive approval flow for each new candidate.

## Relationship scoring

Each contact's score (0–100) is computed from three weighted components:

```
score = recency × 0.45 + frequency × 0.35 + priority × 0.20
```

**Recency** uses a cadence-aware decay. Each relationship type has a different
expected contact interval:

| Type           | Default cadence |
| -------------- | --------------- |
| `family`       | 14 days         |
| `friend`       | 30 days         |
| `colleague`    | 60 days         |
| `other`        | 60 days         |
| `professional` | 90 days         |

Override per contact with `openclaw crm contact edit <email> --cadence <days>`.

**Frequency** counts interactions in the last 90 days (emails, meetings, calls).

**Priority** maps `high` → 100, `medium` → 60, `low` → 20.

Scores are recomputed by the daily cron and can be refreshed manually via
`openclaw crm stats`.

## Contact discovery filters

The scanner automatically skips:

- **No-reply addresses** — matching `noreply`, `no-reply`, `mailer`, `bounce`, `postmaster`, `daemon`
- **Mailing lists** — messages with a `List-Unsubscribe` header
- **Internal domains** — domains in `CRM_INTERNAL_DOMAINS`
- **Large meetings** — calendar events with more than 10 attendees
- **Existing contacts** — already in the database
- **Skip patterns** — domain-level or regex patterns recorded from past rejections

### Auto-add mode

After you make 50 or more approve/reject decisions and your approval rate is 60%
or higher, the CLI suggests enabling auto-add mode. Enable it explicitly:

```bash
CRM_AUTO_MODE=true bun scripts/crm-daily.ts
```

In auto-add mode, candidates that pass all filters are added to the database
without the interactive prompt.

## Email draft system

> Requires `CRM_DRAFT_ENABLED=true`.

Propose a draft reply from the CLI:

```bash
bun scripts/crm-daily.ts  # draft proposals are printed in the daily digest
```

Draft lifecycle: **proposed → approved → pushed to mail provider**. No email is
ever sent automatically. "Push" only creates a draft in your Gmail or Outlook
draft folder for you to review and send.

## LLM relationship profiles

The daily cron calls the configured LLM model to generate a short relationship
profile for each contact based on recent context and interactions. Profiles are
stored in the `contact_summaries` table and regenerated when more than 7 days old.

The profile appears in `openclaw crm contact show <email>` and in `crm_query`
responses for person lookups.

## Database

The SQLite database lives at `~/.openclaw/crm/crm.sqlite` (WAL mode, foreign
keys enabled).

| Table                  | Purpose                                                                         |
| ---------------------- | ------------------------------------------------------------------------------- |
| `contacts`             | Core records: email, name, company, role, type, priority, score, cadence, notes |
| `interactions`         | Email, meeting, and call history (deduplicated by provider message ID)          |
| `follow_ups`           | Tasks and follow-ups — contact-linked or standalone                             |
| `contact_context`      | Freetext snippets from emails, meetings, and notes                              |
| `contact_summaries`    | LLM-generated relationship profiles                                             |
| `meetings`             | Meeting records (transcripts, summaries, attendees)                             |
| `meeting_action_items` | Action items from meetings                                                      |
| `company_news`         | News items associated with contacts' companies                                  |
| `skip_patterns`        | Domain and regex patterns excluded from discovery                               |
| `discovery_decisions`  | Approve/reject decisions used to calibrate auto-add                             |

## Privacy

CRM data is treated as personal and confidential:

- **`crm_query` is direct-only** — automatically suppressed in group chats and channels.
- **Local storage only** — the database is never synced or sent off-device.
- **Email drafts require opt-in** — `CRM_DRAFT_ENABLED` must be set to `true`; drafts are never sent automatically.
- **PII stays local** — discovery, scoring, and profile generation all run against your local database; email content is not uploaded anywhere outside your configured LLM provider.
