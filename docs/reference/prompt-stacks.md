---
title: "Dual Prompt Stacks"
description: "Technical reference for the prompts/claude/ and prompts/openai/ stacks: layout, runtime selection, sync check, and maintenance."
---

# Dual Prompt Stacks — Technical Reference

For the concept-level explanation see [Dual Prompt Stacks](/concepts/prompt-stacks).

## Directory Layout

```
prompts/
├── claude/          # Claude-optimized stack
│   ├── AGENTS.md    # Workspace behavior — natural language, explains "why"
│   ├── ops.md       # Operational facts — prose paragraphs
│   └── security.md  # Data classification — narrative framing
└── openai/          # GPT-optimized stack
    ├── AGENTS.md    # Workspace behavior — XML <section>/<rule> hierarchy
    ├── ops.md       # Operational facts — <fact key="…"> structured blocks
    └── security.md  # Data classification — <tier>/<rule> XML
```

Both stacks are committed to the repo root. No build step is required — these are plain Markdown
and XML files read directly by agents at session start.

## Style Conventions

### Claude stack

| Principle    | Detail                                                             |
| ------------ | ------------------------------------------------------------------ |
| Tone         | Conversational prose. First-person framing.                        |
| Rules        | Stated as principles with reasoning ("Here's why this matters: …") |
| Emphasis     | No ALL-CAPS, no `CRITICAL`, no `MUST` outside actual code strings  |
| Structure    | Markdown `##` headers and bullet lists                             |
| Conditionals | Prose ("When you're in a group chat, …")                           |

### GPT stack

| Principle    | Detail                                                                     |
| ------------ | -------------------------------------------------------------------------- |
| Tone         | Structured XML. Explicit hierarchy.                                        |
| Rules        | `<rule>STATED AS UPPERCASE IMPERATIVES.</rule>`                            |
| Emphasis     | ALL-CAPS for imperative statements; no inline emphasis markers             |
| Structure    | `<section name="…">`, `<subsection>`, `<fact key="…">`, `<step order="N">` |
| Conditionals | `<if context="…"><then>…</then></if>` blocks                               |

## Current File Contents

### `AGENTS.md`

Both versions cover:

- Session startup order (SOUL.md → USER.md → daily notes → MEMORY.md)
- Memory management: daily notes vs. long-term MEMORY.md
- When to load MEMORY.md (private sessions only)
- Red lines (no data exfiltration, no destructive commands without confirmation)
- Data classification tiers: Confidential / Internal / Restricted
- Context-aware behavior in non-private sessions
- Outbound action gating (ask before sending externally)
- Group chat participation rules (when to respond, emoji reactions)
- Heartbeat vs. cron selection criteria
- Periodic check rotation and tracking schema
- Writing style (direct, no sycophancy, banned phrases)
- Message pattern (confirm → work → report)
- Cron standards (log every run, notify on failure only)
- Error reporting (surface to user, never swallow)
- Self-improvement loop (learnings_query, learnings_record)
- Conditional loading rules (MEMORY.md, SKILL.md, HEARTBEAT.md)
- URL scheme restrictions and secret redaction

### `ops.md`

Both versions cover:

- Gateway restart command and verification steps
- Log file paths (gateway, LLM calls DB, agent sessions, macOS unified log)
- `PROMPT_SYNC_CHANNEL` env var for sync-check reporting
- Prompt stack directory paths and which resolver function to use
- Cron naming convention and runtime selection (bun vs. openclaw)
- Nightly job schedule (03:00 local)
- Model swap canary command (`bun shared/test-router.mjs`)
- Key repo-relative file paths (llm-router, model-utils, scripts, etc.)

### `security.md`

Both versions cover:

- Confidential tier: financial data, personal contacts, daily notes, personal email/phone
- Internal tier: strategic notes, tool results, system health, work email
- Restricted tier: public-consumption info; requires explicit "share this" before external send
- Context-aware rules for non-private sessions
- Identity separation: USER.md (everywhere) vs. MEMORY.md (private only)
- Red lines (absolute, no exceptions)
- Security advisory handling (read SECURITY.md before triage)

## Runtime Selection

`getPromptStack(model)` in `shared/llm-router.js` returns the stack path for any model:

```js
import { getPromptStack } from "./shared/llm-router.js";

getPromptStack("claude-sonnet-4-6"); // → 'prompts/claude'
getPromptStack("gpt-4o"); // → 'prompts/openai'
getPromptStack("opus-4"); // → 'prompts/claude'  (alias resolved via model-utils)
getPromptStack("unknown-model"); // → 'prompts/claude'  (fallback)
```

The function calls `detectModelProvider(model)` from `shared/model-utils.js`. Provider `"openai"`
→ `prompts/openai`; `"anthropic"` or `null` → `prompts/claude`.

## What Must Stay Identical

When you update one stack, update the other. The sync check enforces this, but you are the source
of truth. The following must match across both stacks:

| Category            | Examples                                                |
| ------------------- | ------------------------------------------------------- |
| Absolute paths      | `~/.openclaw/llm-calls.db`, `/tmp/openclaw-gateway.log` |
| Shell commands      | `openclaw gateway run`, `openclaw channels status`      |
| Env var names       | `PROMPT_SYNC_CHANNEL`, `LLM_LOG_DB`                     |
| Tier names          | Confidential, Internal, Restricted (exact spelling)     |
| Cron standards      | 03:00 nightly schedule, kebab-case job names            |
| Model IDs           | `claude-sonnet-4-6`, `claude-opus-4-6`, aliases         |
| Repo-relative paths | `shared/llm-router.js`, `scripts/prompt-sync-check.ts`  |

## Sync Check Script

**File:** `scripts/prompt-sync-check.ts`

### Running

```sh
bun scripts/prompt-sync-check.ts        # or: npx tsx scripts/prompt-sync-check.ts
```

Exit 0 = clean. Exit 1 = discrepancies found (output describes each one).

### Algorithm

**Step 1 — Coverage check**

Lists all `.md` files in `prompts/claude/` and `prompts/openai/`. Reports any file present in
one stack but missing from the other.

**Step 2 — Fact extraction**

For each file pair, extracts operational atoms using these patterns:

| Pattern name    | What it matches                                                                   | Notes                                                               |
| --------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ----------- | ---------------- |
| `numeric-id`    | 4+ digit numbers                                                                  | Port numbers, Unix timestamps                                       |
| `abs-path`      | Paths starting with `~/` or `/home`, `/tmp`, `/var`, `/usr`, `/etc`               | Excludes trailing backticks, HTML entities                          |
| `tier-name`     | `Confidential`, `Internal`, `Restricted`                                          | Case-insensitive — matches ALL-CAPS in GPT stack                    |
| `cron-schedule` | `HH:MM AM/PM` or 5-field cron expression                                          |                                                                     |
| `model-id`      | `claude-(opus                                                                     | sonnet                                                              | haiku)-X.Y` | Case-insensitive |
| `model-id-gpt`  | `gpt-*`                                                                           | Case-insensitive                                                    |
| `env-var`       | ALL_CAPS identifiers ending in `_KEY`, `_ID`, `_TOKEN`, `_CHANNEL`, `_DB`, `_LOG` |                                                                     |
| `openclaw-cmd`  | `openclaw <known-subcommand>`                                                     | Whitelist: channels, config, message, gateway, agent, doctor, login |
| `repo-path`     | `shared/`, `src/`, `scripts/`, `docs/`, `prompts/` file paths                     |                                                                     |

**Step 3 — Fact diff**

For each category, computes the symmetric difference between the two stacks' extracted sets.
Reports atoms present in one stack but absent from the other. Uses a threshold of 2 for `numeric-id`
and `env-var` to reduce noise from incidental matches.

**Step 4 — Report**

Writes a structured report to stdout. If `PROMPT_SYNC_CHANNEL` is set, also sends the report
via `openclaw message send` to that channel.

### Testing the script

Introduce a deliberate discrepancy, verify exit 1 with a clear report, revert:

```sh
echo "~/.openclaw/fake-path/test.db" >> prompts/claude/ops.md
npx tsx scripts/prompt-sync-check.ts    # should exit 1
git checkout prompts/claude/ops.md
npx tsx scripts/prompt-sync-check.ts    # should exit 0
```

### Configuring the monitoring channel

```sh
export PROMPT_SYNC_CHANNEL="your-channel-id"
```

When set, the script sends a message to that channel on any failure. If unset, output goes to
stdout only (suitable for cron log capture).

## Nightly Cron

A recurring cron job runs `bun scripts/prompt-sync-check.ts` at 03:17 local time.

The in-session cron is registered via `CronCreate` and auto-expires after 3 days. To re-register
after a session restart, use the tool with the same expression:

```
cron: "17 3 * * *"
prompt: "Run bun scripts/prompt-sync-check.ts from /home/openclaw/openclaw ..."
```

For a persistent cron that survives session restarts, add the command to your system crontab:

```sh
crontab -e
# add: 17 3 * * * cd /home/openclaw/openclaw && bun scripts/prompt-sync-check.ts >> /tmp/prompt-sync.log 2>&1
```

## Maintenance Procedures

### Adding a new file to both stacks

1. Write the Claude version in `prompts/claude/<filename>.md` (prose style)
2. Write the OpenAI version in `prompts/openai/<filename>.md` (XML style) with identical facts
3. Run `npx tsx scripts/prompt-sync-check.ts` — should exit 0
4. Commit both files in the same commit
5. Register any new doc pages in `docs/docs.json`

### Adding a new operational fact to an existing file

1. Add the fact to the Claude version in its prose form
2. Add the identical fact to the OpenAI version in its `<fact key="…">` form
3. Run the sync check
4. If the fact type is not covered by existing extraction patterns, add a new entry to
   `FACT_PATTERNS` in `scripts/prompt-sync-check.ts`

### Adding a new provider

1. Add the provider detection in `detectModelProvider()` in `shared/model-utils.js`
2. Add a new branch in `getPromptStack()` in `shared/llm-router.js` returning the stack path
3. Create `prompts/<provider>/` with files matching both existing stacks in content
4. Update the sync check's `CLAUDE_DIR` / `OPENAI_DIR` constants or extend it to compare
   the new stack against the canonical reference stack
5. Register the new directory in `docs.json` if you add reference docs for it

### Registering new docs pages

Add entries to the correct group in `docs/docs.json`. Concept docs go under the Agents tab;
reference docs go under the Reference tab:

```json
// Agents > Fundamentals
{ "group": "Fundamentals", "pages": ["...", "concepts/prompt-stacks"] }

// Reference > Technical reference
{ "group": "Technical reference", "pages": ["...", "reference/prompt-stacks", "reference/model-swap"] }
```

## Related

- [Dual Prompt Stacks concept](/concepts/prompt-stacks) — why the stacks exist and how they differ
- [Model Swap Procedure](/reference/model-swap) — change the active model and verify the swap
- [Model Failover](/concepts/model-failover) — automatic fallback when a model is unavailable
- [System Prompt concept](/concepts/system-prompt) — how the runtime system prompt is built in code
