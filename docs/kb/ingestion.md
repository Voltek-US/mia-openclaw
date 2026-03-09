---
summary: "Ingest URLs, PDFs, tweets, and YouTube videos into the knowledge base"
read_when:
  - You want to add content to the knowledge base
  - You want to ingest many URLs at once from a file
  - You want to understand how content is sanitized before storage
title: "Ingestion"
---

# Ingestion

The ingestion pipeline fetches a URL, sanitizes the content, chunks it into overlapping
segments, generates embeddings locally, and stores everything in SQLite.

## Single URL

```bash
bun scripts/kb/index.ts ingest <url>
```

Options:

| Flag               | Description                                                                    |
| ------------------ | ------------------------------------------------------------------------------ |
| `--tags tag1,tag2` | Attach one or more tags to the source                                          |
| `--crosspost`      | Post a summary to Slack after ingestion (requires `OPENCLAW_KB_SLACK_WEBHOOK`) |

Examples:

```bash
# Ingest an article with tags
bun scripts/kb/index.ts ingest https://example.com/article --tags ai,research

# Ingest a PDF
bun scripts/kb/index.ts ingest https://example.com/paper.pdf --tags papers,2024

# Ingest a YouTube video (extracts title and description)
bun scripts/kb/index.ts ingest https://www.youtube.com/watch?v=...

# Ingest a tweet (via Twitter oEmbed, no API key needed)
bun scripts/kb/index.ts ingest https://x.com/user/status/123...

# Ingest and cross-post a summary to Slack
OPENCLAW_KB_SLACK_WEBHOOK=https://hooks.slack.com/... \
  bun scripts/kb/index.ts ingest https://example.com/article --crosspost
```

Re-ingesting an existing URL replaces all its chunks (upsert on URL).

## Bulk ingest from a file

```bash
bun scripts/kb/index.ts bulk <urls-file> [--tags tag1,tag2] [--crosspost]
```

The file should have one URL per line. Lines starting with `#` are treated as comments.

```text
# Weekly reading list
https://example.com/article-one
https://example.com/article-two
https://example.com/paper.pdf

# Social
https://x.com/user/status/123...
```

```bash
bun scripts/kb/index.ts bulk urls.txt --tags weekly
```

Each URL is processed sequentially. Failures are logged and counted but do not
stop the bulk run.

## Ingestion pipeline steps

### 1. URL validation

Only `http://` and `https://` schemes are accepted. `file://`, `ftp://`, `data:`,
`javascript:`, and all other schemes are rejected before any network request is made.

### 2. Tracking parameter cleanup

Common tracking parameters are removed from the URL before fetching and storage:

```
utm_source  utm_medium  utm_campaign  utm_term  utm_content
utm_id      fbclid      gclid         msclkid   twclid
ref         source      _ga           mc_cid    mc_eid  yclid
```

### 3. Fetch

Content is fetched with a 30-second timeout and a 10 MB body cap.
The fetch strategy depends on source type:

| Source    | Strategy                                                                    |
| --------- | --------------------------------------------------------------------------- |
| `article` | Fetch HTML, extract readable text via `linkedom` + Mozilla Readability      |
| `tweet`   | `publish.twitter.com/oembed` (no auth); falls back to article extraction    |
| `youtube` | `youtube.com/oembed` for title; `<meta name="description">` from watch page |
| `pdf`     | Download binary, parse text page-by-page with `pdfjs-dist`                  |

Source type is inferred automatically from the URL hostname and path.

### 4. Sanitization

Two passes run on the extracted text before it enters the database:

**Regex pass (always on)**

Matches and redacts 15+ patterns including:

- `ignore previous instructions`, `forget everything` and similar overrides
- `system:`, `[INST]`, `<<SYS>>`, `###System:` prompt-injection markers
- `reveal your instructions`, `print your prompt` exfiltration probes
- `<script>`, `javascript:`, `onerror=` and other XSS-style tags

Matched spans are replaced with `[REDACTED:Nch]` and a count is logged.

**Semantic scan (optional)**

When `OPENCLAW_KB_SEMANTIC_SCAN=1` and `ANTHROPIC_API_KEY` is set, a 2000-character
fingerprint of the content is sent to Claude Haiku to detect sophisticated attacks
that evade regex (encoded payloads, steganographic injection, etc.).

The full page content is never sent to the agent conversation loop.
If the scan flags the content as unsafe, ingestion is aborted.

### 5. Chunking

Text is split into overlapping segments using a sentence-aware sliding window:

- **Target size**: ~400 words (~512 tokens) per chunk
- **Overlap**: ~40 words between adjacent chunks to preserve context at boundaries
- **Atomic unit**: sentences — chunks never cut mid-sentence
- Paragraph breaks are respected before sentence splitting

### 6. Embedding

Each chunk is embedded using a local ONNX model via `@xenova/transformers`.
The default model is `Xenova/all-MiniLM-L6-v2` (384-dimensional, ~22 MB).

The model downloads automatically on first use and is cached in
`~/.cache/huggingface/hub/`. No API key or network connection is needed after
the initial download.

Override the model with the `OPENCLAW_KB_EMBED_MODEL` environment variable.

### 7. Storage

Each source and its chunks are stored in SQLite at `~/.openclaw/kb/knowledge.db`.
Embeddings are stored as raw `BLOB` (packed `Float32Array`) for efficient loading.

### Concurrency lock

A PID-based lock file at `~/.openclaw/kb/ingest.lock` prevents concurrent ingestions.
The lock is released automatically on completion or error.
Stale locks from dead processes are detected and removed automatically.

## Cross-posting

When `--crosspost` is passed and `OPENCLAW_KB_SLACK_WEBHOOK` is set, a summary is
posted to Slack after each successful ingest. The post includes:

- Source title and URL
- Source type, chunk count, tags, and ingest date
- Sanitization summary

Raw page content is never included in the cross-post.
