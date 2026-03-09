---
title: "HEARTBEAT.md Template"
summary: "Workspace template for HEARTBEAT.md"
read_when:
  - Bootstrapping a workspace manually
---

# HEARTBEAT.md

<!-- Keep this short. Every line runs on every heartbeat. -->

## SMART MEMORY LOADING (do this first, every heartbeat)

Before anything else, load context efficiently:

1. Run `projects_query` with `status: active` — compact project registry from the SQL DB
2. Use `memory_search` to load MEMORY.md context (~3K tokens)
3. Only load daily notes (`memory/YYYY-MM-DD.md`) when asked about specific past work
4. Only run `memory_search` for specifics when a past-work question comes up

This gives full context at ~10% of the token cost. Daily notes are archives, not runtime docs.

## Checks

- [ ] Unread email — any urgent items?
- [ ] Calendar — events in next 2h?
- [ ] Failed cron jobs — any errors in DB?
- [ ] Disk / memory — any resource alerts?

## Notify when

- Important email arrived
- Calendar event < 2h away
- Any cron failure
- System resource alert

## Stay silent (HEARTBEAT_OK) when

- Nothing new since last check
- 23:00–08:00 unless urgent

## Vector Memory Flush (every heartbeat)

Run `memory_search` with a broad query (e.g. "recent work decisions") to trigger background
re-indexing if any memory files changed since the last run.
If the result returns 0 new items, that is fine — nothing new to embed.
