#!/bin/bash
# Quick RAG search for Mia — returns JSON results
# Usage: rag-search.sh "query" [top_n] [--context]
#
# Output: JSON array of results with score, title, date, content
# Designed to be called by Mia via exec during conversations

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DB="${MIA_DB_DIR:-$HOME/.openclaw/ledi}/ledi-chatgpt.sqlite"

QUERY="${1:?Usage: rag-search.sh \"query\" [top_n]}"
TOP="${2:-5}"
CONTEXT="${3:-}"

ARGS=(search "$QUERY" --top "$TOP" --db "$DB")
if [[ "$CONTEXT" == "--context" ]]; then
    ARGS+=(--context)
fi

python3 "$SCRIPT_DIR/chatgpt-rag.py" "${ARGS[@]}"
