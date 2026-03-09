---
summary: "Build a local RAG knowledge base from URLs, PDFs, tweets, and YouTube videos"
read_when:
  - You want to ingest articles, PDFs, or videos into a searchable knowledge base
  - You want semantic search over a personal document collection
  - You want to build a RAG pipeline without external embedding API costs
title: "Knowledge Base (RAG)"
---

# Knowledge Base (RAG)

The `scripts/kb` module provides a local Retrieval-Augmented Generation (RAG) pipeline.
It ingests content from URLs, runs it through a sanitization layer, chunks and embeds it locally,
and stores everything in SQLite — no cloud embedding API required.

## Architecture

```
URL → validate scheme → fetch → sanitize → chunk → embed (local) → SQLite
                                                                        ↓
query text → embed → cosine similarity over all chunks → ranked results
```

### Components

| Module          | Purpose                                                              |
| --------------- | -------------------------------------------------------------------- |
| `fetch.ts`      | Per-source-type fetching: articles, tweets, YouTube, PDFs            |
| `sanitize.ts`   | Deterministic regex scan + optional model-based semantic scan        |
| `chunk.ts`      | Sentence-aware sliding window (400-word target, 40-word overlap)     |
| `embeddings.ts` | Local `@xenova/transformers` model (all-MiniLM-L6-v2, 384-dim)       |
| `db.ts`         | SQLite via Node 22 built-in `node:sqlite`                            |
| `lock.ts`       | PID-based lock file prevents concurrent ingestions                   |
| `preflight.ts`  | Validates paths, DB integrity, and lock state before every operation |
| `crosspost.ts`  | Optional Slack webhook summary after each ingest                     |
| `index.ts`      | CLI entry point                                                      |

### Storage layout

All data lives under `~/.openclaw/kb/`:

```
~/.openclaw/kb/
  knowledge.db      SQLite database (sources + chunks tables)
  ingest.lock       PID-based lock file (present only during ingestion)
```

## Setup

Install the local embedding model (one-time, ~22 MB download on first use):

```bash
pnpm add -D @xenova/transformers
```

No API key is required. The model (`Xenova/all-MiniLM-L6-v2`) is downloaded from
Hugging Face and cached in `~/.cache/huggingface/hub/`.

### Optional environment variables

| Variable                    | Purpose                                                                |
| --------------------------- | ---------------------------------------------------------------------- |
| `OPENCLAW_KB_SLACK_WEBHOOK` | Slack incoming webhook URL for cross-post summaries                    |
| `OPENCLAW_KB_SEMANTIC_SCAN` | Set to `1` to enable model-based injection scan                        |
| `ANTHROPIC_API_KEY`         | Required when `OPENCLAW_KB_SEMANTIC_SCAN=1`                            |
| `OPENCLAW_KB_EMBED_MODEL`   | Override the embedding model name (default: `Xenova/all-MiniLM-L6-v2`) |

## Source types

| Type      | How it is fetched                                |
| --------- | ------------------------------------------------ |
| `article` | HTML via `linkedom` + Mozilla Readability        |
| `tweet`   | Twitter oEmbed API (no auth required)            |
| `youtube` | YouTube oEmbed API + `<meta name="description">` |
| `pdf`     | Downloaded and parsed with `pdfjs-dist`          |

Source type is detected automatically from the URL.
Re-ingesting an existing URL refreshes all chunks.

## Security model

All fetched content passes through two sanitization steps before storage:

1. **Regex pass** — 15+ patterns catch common prompt-injection, role-override, and XSS-style attacks. Matched spans are replaced with `[REDACTED:Nch]`.
2. **Semantic scan (optional)** — sends a 2000-character fingerprint to Claude Haiku when `OPENCLAW_KB_SEMANTIC_SCAN=1`. The raw page content is never sent to the agent conversation loop.

URL scheme validation rejects everything except `http://` and `https://`.
Tracking parameters (`utm_*`, `fbclid`, `gclid`, etc.) are stripped before storage.

## Next steps

- [Ingestion](/kb/ingestion) — ingest URLs, bulk ingest, sanitization details
- [Querying](/kb/querying) — semantic search, filtering, similarity threshold
- [Management](/kb/management) — list, delete, status, bulk operations
