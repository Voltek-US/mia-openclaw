---
title: "Dual Prompt Stacks"
description: "Why OpenClaw maintains separate Claude-optimized and GPT-optimized instruction files, and how the right one is selected at runtime."
---

# Dual Prompt Stacks

## The Problem

Different frontier models respond to the same instruction written two different ways.

Claude models parse natural, explanatory prose well. When instructions are written in an urgent,
marker-heavy style — `CRITICAL:`, `MUST`, `IMPORTANT!!!` — Claude tends to overtrigger on the
emphasis and treats every item as equally urgent, making it harder to reason about priority.

GPT models work better with explicit structural markers. XML tags, ALL-CAPS for imperative rules,
and numbered decision trees give GPT clear hierarchy. Loose prose without explicit structure can
cause it to miss or deprioritize rules.

Since OpenClaw can route to either provider, a single system prompt written in one style degrades
performance on the other model.

## The Solution

Two directories. Same facts. Different formatting.

```
prompts/
├── claude/    ← natural language, explains "why", no ALL-CAPS urgency
└── openai/    ← XML structure, ALL-CAPS rules, explicit decision trees
```

Every file that exists in `prompts/claude/` must also exist in `prompts/openai/`, with the same
operational facts expressed in the model-appropriate style. A nightly sync check enforces parity.

## What Counts as an Operational Fact

Facts are the values that must be identical across both stacks:

- File paths (`~/.openclaw/agents/`, `/tmp/openclaw-gateway.log`)
- Shell commands (`openclaw gateway run`, `openclaw channels status`)
- Environment variable names (`PROMPT_SYNC_CHANNEL`, `LLM_LOG_DB`)
- Data classification tier names (Confidential, Internal, Restricted)
- Cron schedule standards (03:00 nightly, kebab-case job names)
- Model IDs and aliases

Only _how_ these facts are written — their formatting and surrounding context — differs between stacks.

## How the Stack is Selected

At runtime, `getPromptStack(model)` in `shared/llm-router.js` maps the current model to the
correct directory:

```
claude-sonnet-4-6  →  prompts/claude/
gpt-4o             →  prompts/openai/
opus-4             →  prompts/claude/  (alias resolved first)
```

The function delegates to `detectModelProvider()` from `shared/model-utils.js`. When the
provider is `"openai"` the GPT stack is used; for `"anthropic"` or unknown the Claude stack is
the default.

## The Sync Check

`scripts/prompt-sync-check.ts` runs nightly at 03:17 local time. It:

1. Checks that every file in one stack has a counterpart in the other
2. Extracts operational atoms from both versions of each file using regex patterns
3. Reports any atoms present in one stack but absent from the other

Exit 0 means clean. Exit 1 means drift — the report tells you exactly which file and which
category of fact diverged.

Typical class of bug it catches: "I updated the gateway restart command in the Claude prompts
but forgot the GPT prompts." Without the check, this kind of drift compounds quietly over weeks.

## Style Reference

### Claude stack (`prompts/claude/`)

Rules are stated as principles with reasoning:

> When you're in a non-private context (a group chat, a shared channel, or anywhere ambiguous):
> don't recall or surface Confidential items. The reason is that MEMORY.md contains personal
> context that shouldn't leak to other participants.

No markdown headers written in ALL-CAPS. No "CRITICAL" or "MUST" outside actual code strings.
First-person, warm-but-direct tone. Markdown headers and bullet lists for structure.

### GPT stack (`prompts/openai/`)

Rules are stated as commands wrapped in XML hierarchy:

```xml
<section name="data_classification">
  <tier name="confidential" scope="private_dm_only">
    <rule>NEVER SURFACE CONFIDENTIAL ITEMS OUTSIDE A PRIVATE/DIRECT MESSAGE CONTEXT.</rule>
  </tier>
  ...
</section>
```

ALL-CAPS for imperative statements. Explicit `<if context="…"><then>…</then></if>` blocks for
conditional behavior. Numbered steps for ordered procedures.

## Files in Each Stack

Both stacks currently contain three files:

| File          | Contents                                                                                                                    |
| ------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `AGENTS.md`   | Workspace behavior: session startup, memory management, group chat rules, heartbeats, self-improvement, conditional loading |
| `ops.md`      | Operational facts: gateway commands, log paths, cron naming, prompt stack resolver, model swap verification                 |
| `security.md` | Data classification tiers (Confidential, Internal, Restricted), context-aware rules, red lines                              |

## Related

- [Dual Prompt Stacks reference](/reference/prompt-stacks) — technical details: directory layout, sync script internals, adding files and facts
- [Model Swap Procedure](/reference/model-swap) — how to change the active model and verify the swap
- [Model Failover](/concepts/model-failover) — automatic fallback when a model is unavailable
- [System Prompt](/concepts/system-prompt) — how OpenClaw builds the runtime system prompt
