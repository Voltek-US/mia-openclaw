---
summary: "Semantic search over the knowledge base with tag and type filters"
read_when:
  - You want to search the knowledge base
  - You want to filter results by tag, source type, or date range
  - You want to tune the similarity threshold or result count
title: "Querying"
---

# Querying

The query engine embeds your search text locally, computes cosine similarity against
every chunk in the database, and returns the most relevant passages ranked by score.

## Basic query

```bash
bun scripts/kb/index.ts query "<search text>"
```

Output example:

```
[kb] Top 3 result(s) for: "how does attention work in transformers"

─── [0.8712] Attention Is All You Need
    Source #4 | article | 2024-11-03 | tags: papers,ml
    URL: https://example.com/attention-paper
    Chunk 2: The attention mechanism allows the model to focus on different parts of
    the input sequence when producing each element of the output sequence…

─── [0.7491] Illustrated Transformer
    Source #7 | article | 2024-11-10 | tags: ml,tutorials
    URL: https://example.com/illustrated-transformer
    Chunk 0: The Transformer uses an encoder-decoder structure where both halves are
    built entirely out of stacked self-attention and feed-forward layers…
```

## Query options

| Flag                 | Default | Description                                                       |
| -------------------- | ------- | ----------------------------------------------------------------- |
| `--limit N`          | `5`     | Maximum number of results to return                               |
| `--threshold F`      | `0.3`   | Minimum cosine similarity (0–1); lower values return more results |
| `--tags t1,t2`       | —       | Only search chunks from sources with at least one matching tag    |
| `--source-type TYPE` | —       | Only search chunks from a specific source type                    |
| `--from YYYY-MM-DD`  | —       | Only include sources ingested on or after this date               |
| `--to YYYY-MM-DD`    | —       | Only include sources ingested on or before this date              |

## Filtering examples

```bash
# Return up to 10 results with a tighter threshold
bun scripts/kb/index.ts query "RAG pipeline" --limit 10 --threshold 0.5

# Only search PDFs
bun scripts/kb/index.ts query "methodology" --source-type pdf

# Only search sources tagged "weekly"
bun scripts/kb/index.ts query "LLM benchmarks" --tags weekly

# Combine tag and date filters
bun scripts/kb/index.ts query "fine-tuning" --tags papers --from 2024-01-01 --to 2024-06-30

# Broad search across tweets and articles
bun scripts/kb/index.ts query "AI safety" --source-type tweet --limit 20 --threshold 0.2
```

## How similarity scoring works

1. The query text is embedded with the same local model used at ingest time
   (`Xenova/all-MiniLM-L6-v2` by default).
2. Cosine similarity is computed between the query vector and every stored chunk
   embedding in memory.
3. Results below the similarity threshold are discarded.
4. The remaining results are sorted by similarity (highest first) and truncated
   to `--limit`.

Because `all-MiniLM-L6-v2` produces L2-normalized vectors, cosine similarity
equals the dot product, which is fast to compute in pure JavaScript without a
vector database extension.

### Choosing a threshold

| Threshold | Behavior                                                 |
| --------- | -------------------------------------------------------- |
| `0.7–1.0` | Very tight — only near-exact semantic matches            |
| `0.4–0.7` | Good balance for most knowledge-base queries             |
| `0.2–0.4` | Broad — useful for exploratory search; expect more noise |
| `< 0.2`   | Very loose — likely to return unrelated passages         |

The default threshold of `0.3` works well for general-purpose queries.
Raise it when results are too noisy; lower it when too few results are returned.

## Source types

Valid values for `--source-type`:

| Value     | Description                               |
| --------- | ----------------------------------------- |
| `article` | Web pages parsed with Mozilla Readability |
| `tweet`   | Twitter/X posts via oEmbed                |
| `youtube` | YouTube video titles and descriptions     |
| `pdf`     | PDF documents parsed with pdfjs-dist      |
| `unknown` | Sources where type detection failed       |
