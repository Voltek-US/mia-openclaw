# Mia — Ledi's Personal Assistant

Mia is an OpenClaw-powered personal assistant managing household, business, and communications for Ledi Vokshi.

## Structure

```
ledi/
├── bin/                    # Scripts and tools
│   ├── chatgpt-rag.py      # RAG pipeline: chunk, embed, search, tag
│   ├── import-chatgpt.py   # Import ChatGPT export into SQLite
│   ├── rag-search.sh       # Quick RAG search wrapper
│   ├── heartbeat-tick.sh   # Heartbeat queue processor
│   ├── task-*.sh            # Task queue management
│   ├── shopping.sh          # Shopping list management
│   ├── errors-*.sh          # Error tracking
│   └── init-db.sh           # DB schema init/migration
├── workspace/              # OpenClaw workspace files
│   ├── AGENTS.md            # Operational rules
│   ├── SOUL.md              # Personality & tone
│   ├── IDENTITY.md          # Who Mia is
│   ├── USER.md              # About Ledi & Luis
│   ├── TOOLS.md             # Tool config & paths
│   ├── HEARTBEAT.md         # Heartbeat behavior
│   ├── BOOTSTRAP.md         # Startup guardrails
│   └── MEMORY.md            # Long-term memory
└── README.md
```

## ChatGPT RAG Pipeline

Ledi's full ChatGPT history (501 conversations, Sep 2024 – Mar 2026) indexed for semantic search.

### Setup

```bash
# 1. Import ChatGPT export
python3 bin/import-chatgpt.py /path/to/chatgpt-export/

# 2. Chunk conversations
python3 bin/chatgpt-rag.py chunk

# 3. Generate embeddings (requires OPENAI_API_KEY)
python3 bin/chatgpt-rag.py embed

# 4. Auto-tag topics
python3 bin/chatgpt-rag.py tag
```

### Search

```bash
# Hybrid search (BM25 + vector + RRF + recency + MMR)
python3 bin/chatgpt-rag.py search "business strategy" --top 5

# Ledi's voice only (filter out ChatGPT responses)
python3 bin/chatgpt-rag.py search "money beliefs" --ledi-only

# JSON output for programmatic use
python3 bin/chatgpt-rag.py search "query" --json --context

# Stats
python3 bin/chatgpt-rag.py stats
```

### Search Features
- **Hybrid:** BM25 keyword + vector semantic, fused with Reciprocal Rank Fusion
- **Recency boost:** newer conversations score higher (180-day half-life)
- **MMR diversity:** results diversified across conversations
- **Ledi voice filter:** isolate her actual words from ChatGPT responses
- **Context window:** `--context` returns surrounding chunks

### Requirements
- Python 3.10+
- `openai` package (`pip install openai`)
- `numpy`
- `OPENAI_API_KEY` environment variable
