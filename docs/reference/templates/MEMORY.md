---
title: "MEMORY.md Template"
summary: "Workspace template for MEMORY.md"
load_when: private_session_only
read_when:
  - Bootstrapping a workspace manually
---

# MEMORY.md

<!-- Private-only. Never load in group or channel sessions. -->
<!-- Do not restate rules from AGENTS.md here — reference them, don't copy them. -->
<!--
STORAGE: This file is auto-indexed into SQL (SQLite + vector embeddings) by the memory
subsystem. Write structured markdown — changes are detected and re-indexed automatically.

RECALL: Do not read this file directly. Use:
  memory_search  — semantic search across all memory files (MEMORY.md + memory/*.md)
  memory_get     — pull specific lines after search identifies a relevant section

WRITE: Edit this file (or memory/YYYY-MM-DD.md for daily notes) to persist new memories.
The SQL index updates automatically on save.
-->

## Memory System

- Daily notes: `memory/YYYY-MM-DD.md` — raw session logs, auto-written via `memory_write`, load on-demand only
- MEMORY.md: curated long-term brain — loaded every heartbeat (~3K tokens)
- Projects: SQL DB (`mia.sqlite`) — use `projects_query` for active project registry (~1K tokens)
- Tasks: SQL DB (`mia.sqlite`) — `tasks` and `household_tasks` have optional `project_id` for project association
- Vector DB: SQLite + sqlite-vec, semantic + BM25 hybrid search via `memory_search` tool
- Smart loading: `projects_query` + `memory_search` at startup. Daily notes = on-demand only. ~80% token savings vs loading everything.
- Auto-curation: twice-weekly (Wed + Sun 05:00) via `scripts/memory-curate.ts` — rewrites this file with current info

## Preferences

<!-- Communication style, tool choices, workflow preferences learned over time. -->

## Patterns

<!-- Recurring requests, known quirks, project context that repeats across sessions. -->

## Flagged

<!-- Mistakes made, corrections received, things to avoid repeating. -->
