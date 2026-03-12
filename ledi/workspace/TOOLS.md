---
summary: "Mia tool configuration — paths, channel IDs, API token locations"
---

# TOOLS.md

## Channel IDs

<!-- Telegram DM: set LEDI_TELEGRAM_CHAT_ID in ~/.openclaw/ledi/.env -->
<!-- OpenClaw community Telegram group: set OPENCLAW_COMMUNITY_TG_ID in .env -->
<!-- OpenClaw community Discord server: set OPENCLAW_COMMUNITY_DISCORD_ID in .env -->

## File Paths

- **Mia DB:** `~/.openclaw/ledi/mia.sqlite` (override with `MIA_DB_DIR`)
- **Mia env:** `~/.openclaw/ledi/.env`
- **Daily memory notes:** `workspaces/ledi/memory/YYYY-MM-DD.md`
- **Long-term memory:** `workspaces/ledi/MEMORY.md`
- **LLM router:** `shared/llm-router.js`

## ChatGPT RAG Pipeline

- **DB:** `~/.openclaw/ledi/ledi-chatgpt.sqlite`
- **Scripts:** `~/.openclaw/ledi/bin/chatgpt-rag.py` (chunk, embed, search, tag, stats)
- **Quick search:** `~/.openclaw/ledi/bin/rag-search.sh "query" [top_n]`
- **Stats:** 501 conversations, 7,281 chunks, 4.7M tokens, all embedded
- **Topics:** 469 conversations auto-tagged across 30 categories
- **Re-import:** `~/.openclaw/ledi/bin/import-chatgpt.py <export_dir>` then `chatgpt-rag.py chunk --force && chatgpt-rag.py embed`

## API Token Locations

All tokens in `~/.openclaw/ledi/.env` — never in conversation history:

```
LEDI_TELEGRAM_CHAT_ID=...
TWITTER_BEARER_TOKEN=...
INSTAGRAM_ACCESS_TOKEN=...
LINKEDIN_ACCESS_TOKEN=...
YOUTUBE_API_KEY=...
GOOGLE_CALENDAR_TOKEN=...
MIA_DB_DIR=~/.openclaw/ledi
```

## SSH Hosts

<!-- Add gateway hosts here if Mia needs remote access -->

## Device Aliases

<!-- Add any smart home device aliases here as integrations are added -->
