#!/usr/bin/env python3
"""
ChatGPT RAG pipeline — Ledi's conversation history.

Best-practice RAG:
  - Conversation-turn-aware chunking with metadata headers
  - Hybrid search: BM25 (FTS5) + cosine vector similarity
  - Reciprocal Rank Fusion (RRF) to combine
  - Context window: returns surrounding chunks for coherence
  - Minimum chunk quality threshold

Commands:
    chunk     - Chunk conversations into searchable segments
    embed     - Generate embeddings for all unembedded chunks
    search    - Hybrid search (BM25 + vector + RRF)
    stats     - Show DB stats

Usage:
    python3 chatgpt-rag.py chunk [--force]
    python3 chatgpt-rag.py embed [--batch-size 100]
    python3 chatgpt-rag.py search "query" [--top 5] [--context]
    python3 chatgpt-rag.py stats
"""

import argparse
import json
import os
import sqlite3
import struct
import sys
import time
from datetime import datetime, timezone

import numpy as np

DB_DEFAULT = os.path.expanduser("~/.openclaw/ledi/ledi-chatgpt.sqlite")

# ── Chunking config ──────────────────────────────────────
# Target: 300-600 tokens per chunk (sweet spot for retrieval precision)
TARGET_CHUNK_TOKENS = 400
MAX_CHUNK_TOKENS = 600
MIN_CHUNK_TOKENS = 80
OVERLAP_TURNS = 1           # overlap N conversation turns between chunks

# ── Search config ────────────────────────────────────────
RRF_K = 60                  # RRF constant (standard value)
VECTOR_WEIGHT = 0.6         # weight for vector in final score
BM25_WEIGHT = 0.4           # weight for BM25 in final score
MMR_LAMBDA = 0.7            # diversity vs relevance (1.0 = pure relevance, 0.0 = pure diversity)
RECENCY_BOOST_MAX = 0.15    # max score boost for most recent conversations
RECENCY_HALF_LIFE_DAYS = 180  # half-life for recency decay


def get_db(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def estimate_tokens(text: str) -> int:
    return max(1, len(text) // 4)


def ts_to_date(ts):
    if ts:
        try:
            return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d")
        except (ValueError, OSError):
            pass
    return "unknown"


def ts_to_iso(ts):
    if ts:
        try:
            return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()
        except (ValueError, OSError):
            pass
    return None


# ── Schema ───────────────────────────────────────────────

def init_schema(conn: sqlite3.Connection):
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS chunks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id TEXT NOT NULL,
            conversation_title TEXT,
            chunk_index INTEGER,
            total_chunks INTEGER,
            content TEXT NOT NULL,          -- raw conversation text
            metadata_header TEXT,           -- prepended for embedding: title, date, topic hints
            roles TEXT,                     -- 'user', 'assistant', 'both'
            token_estimate INTEGER,
            create_time REAL,
            date_str TEXT,
            FOREIGN KEY (conversation_id) REFERENCES conversations(id)
        );

        CREATE TABLE IF NOT EXISTS embeddings (
            chunk_id INTEGER PRIMARY KEY,
            embedding BLOB NOT NULL,
            model TEXT DEFAULT 'text-embedding-3-small',
            created_at TEXT,
            FOREIGN KEY (chunk_id) REFERENCES chunks(id)
        );

        -- FTS5 for BM25 keyword search
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
            content,
            metadata_header,
            content='chunks',
            content_rowid='id',
            tokenize='porter unicode61'
        );

        -- Triggers to keep FTS in sync
        CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
            INSERT INTO chunks_fts(rowid, content, metadata_header)
            VALUES (new.id, new.content, new.metadata_header);
        END;

        CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
            INSERT INTO chunks_fts(chunks_fts, rowid, content, metadata_header)
            VALUES ('delete', old.id, old.content, old.metadata_header);
        END;

        CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
            INSERT INTO chunks_fts(chunks_fts, rowid, content, metadata_header)
            VALUES ('delete', old.id, old.content, old.metadata_header);
            INSERT INTO chunks_fts(rowid, content, metadata_header)
            VALUES (new.id, new.content, new.metadata_header);
        END;

        CREATE INDEX IF NOT EXISTS idx_chunks_convo ON chunks(conversation_id);
        CREATE INDEX IF NOT EXISTS idx_chunks_convo_idx ON chunks(conversation_id, chunk_index);
        CREATE INDEX IF NOT EXISTS idx_chunks_date ON chunks(date_str);
    """)
    conn.commit()


def drop_chunks(conn):
    """Clean slate for re-chunking."""
    conn.executescript("""
        DROP TABLE IF EXISTS embeddings;
        DROP TABLE IF EXISTS chunks_fts;
        DROP TABLE IF EXISTS chunks;
        DROP TRIGGER IF EXISTS chunks_ai;
        DROP TRIGGER IF EXISTS chunks_ad;
        DROP TRIGGER IF EXISTS chunks_au;
    """)
    conn.commit()


# ── Chunking ─────────────────────────────────────────────

def split_large_text(text: str, max_chars: int = 2000) -> list:
    """
    Split large text blocks at paragraph boundaries.
    Returns list of text segments.
    """
    if len(text) <= max_chars:
        return [text]

    segments = []
    start = 0
    while start < len(text):
        end = start + max_chars
        if end >= len(text):
            segments.append(text[start:])
            break
        # Find paragraph break
        br = text.rfind("\n\n", start + max_chars // 2, end)
        if br <= start:
            br = text.rfind("\n", start + max_chars // 2, end)
        if br <= start:
            br = end
        segments.append(text[start:br].strip())
        start = br
        while start < len(text) and text[start] == "\n":
            start += 1
    return [s for s in segments if s]


def parse_turns(messages: list) -> list:
    """
    Parse raw messages into turns: [{role, content, create_time}]
    Merge consecutive same-role messages.
    Split overly large turns into sub-turns.
    """
    turns = []
    for role, content, ctime in messages:
        content = (content or "").strip()
        if not content:
            continue
        # Truncate absurdly long single messages (code dumps, etc.)
        if len(content) > 8000:
            content = content[:8000] + "\n...[truncated]"

        # Merge consecutive same-role
        if turns and turns[-1]["role"] == role:
            turns[-1]["content"] += "\n\n" + content
            turns[-1]["create_time"] = ctime or turns[-1]["create_time"]
        else:
            turns.append({"role": role, "content": content, "create_time": ctime})

    # Split large turns into sub-turns (max ~500 tokens = ~2000 chars)
    split_turns = []
    for turn in turns:
        if estimate_tokens(turn["content"]) > MAX_CHUNK_TOKENS:
            segments = split_large_text(turn["content"], max_chars=MAX_CHUNK_TOKENS * 4)
            for seg in segments:
                split_turns.append({"role": turn["role"], "content": seg, "create_time": turn["create_time"]})
        else:
            split_turns.append(turn)

    return split_turns


def format_turn(turn: dict) -> str:
    prefix = "Ledi" if turn["role"] == "user" else "ChatGPT" if turn["role"] == "assistant" else turn["role"]
    return f"[{prefix}]: {turn['content']}"


def build_metadata_header(title: str, date_str: str, roles: str, chunk_idx: int, total: int) -> str:
    """
    Metadata header prepended to chunk content when embedding.
    Helps the embedding model understand context.
    """
    parts = [f"Conversation: {title}", f"Date: {date_str}"]
    if roles == "user":
        parts.append("Speaker: Ledi only")
    elif roles == "assistant":
        parts.append("Speaker: ChatGPT only")
    else:
        parts.append("Speakers: Ledi and ChatGPT")
    if total > 1:
        parts.append(f"Part {chunk_idx + 1}/{total}")
    return " | ".join(parts)


def chunk_conversation(conv_id: str, title: str, create_time, messages: list) -> list:
    """
    Conversation-turn-aware chunking.
    Splits at turn boundaries, targets 300-600 tokens, overlaps by N turns.
    """
    turns = parse_turns(messages)
    if not turns:
        return []

    date_str = ts_to_date(create_time)

    # Check total size — if small enough, single chunk
    all_text = "\n\n".join(format_turn(t) for t in turns)
    total_tokens = estimate_tokens(all_text)

    if total_tokens < MIN_CHUNK_TOKENS:
        return []

    if total_tokens <= MAX_CHUNK_TOKENS:
        roles = _detect_roles(all_text)
        header = build_metadata_header(title, date_str, roles, 0, 1)
        return [{
            "conversation_id": conv_id,
            "conversation_title": title,
            "chunk_index": 0,
            "total_chunks": 1,
            "content": all_text,
            "metadata_header": header,
            "roles": roles,
            "token_estimate": total_tokens,
            "create_time": create_time,
            "date_str": date_str,
        }]

    # Multi-chunk: accumulate turns until target reached
    chunks = []
    current_turns = []
    current_tokens = 0

    for i, turn in enumerate(turns):
        turn_text = format_turn(turn)
        turn_tokens = estimate_tokens(turn_text)

        # Would adding this turn exceed max?
        if current_tokens + turn_tokens > MAX_CHUNK_TOKENS and current_tokens >= MIN_CHUNK_TOKENS:
            # Flush current chunk
            chunks.append(_make_chunk(current_turns, conv_id, title, create_time, date_str, len(chunks)))
            # Overlap: keep last N turns
            overlap = current_turns[-OVERLAP_TURNS:] if OVERLAP_TURNS else []
            current_turns = list(overlap)
            current_tokens = sum(estimate_tokens(format_turn(t)) for t in current_turns)

        current_turns.append(turn)
        current_tokens += turn_tokens

    # Flush remaining
    if current_tokens >= MIN_CHUNK_TOKENS:
        chunks.append(_make_chunk(current_turns, conv_id, title, create_time, date_str, len(chunks)))
    elif chunks and current_turns:
        # Too small — merge with last chunk
        last = chunks[-1]
        extra_text = "\n\n".join(format_turn(t) for t in current_turns)
        last["content"] += "\n\n" + extra_text
        last["token_estimate"] = estimate_tokens(last["content"])

    # Set total_chunks
    total = len(chunks)
    for c in chunks:
        c["total_chunks"] = total
        c["metadata_header"] = build_metadata_header(title, date_str, c["roles"], c["chunk_index"], total)

    return chunks


def _make_chunk(turns, conv_id, title, create_time, date_str, idx):
    text = "\n\n".join(format_turn(t) for t in turns)
    roles = _detect_roles(text)
    return {
        "conversation_id": conv_id,
        "conversation_title": title,
        "chunk_index": idx,
        "total_chunks": 0,  # set later
        "content": text,
        "metadata_header": "",  # set later
        "roles": roles,
        "token_estimate": estimate_tokens(text),
        "create_time": create_time,
        "date_str": date_str,
    }


def _detect_roles(text):
    has_user = "[Ledi]:" in text
    has_asst = "[ChatGPT]:" in text
    if has_user and has_asst:
        return "both"
    elif has_user:
        return "user"
    elif has_asst:
        return "assistant"
    return "other"


# ── Embedding ────────────────────────────────────────────

def get_embeddings_batch(texts: list, model: str = "text-embedding-3-small") -> list:
    import openai
    client = openai.OpenAI(api_key=os.environ["OPENAI_API_KEY"])
    response = client.embeddings.create(input=texts, model=model)
    return [d.embedding for d in response.data]


def embedding_to_blob(embedding: list) -> bytes:
    return struct.pack(f"{len(embedding)}f", *embedding)


def blob_to_embedding(blob: bytes) -> np.ndarray:
    n = len(blob) // 4
    return np.array(struct.unpack(f"{n}f", blob), dtype=np.float32)


# ── Search ───────────────────────────────────────────────

def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    norm_a = np.linalg.norm(a)
    norm_b = np.linalg.norm(b)
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return float(np.dot(a, b) / (norm_a * norm_b))


def bm25_search(conn, query: str, limit: int = 50) -> list:
    """FTS5 BM25 search. Returns [(chunk_id, bm25_score), ...]"""
    try:
        rows = conn.execute("""
            SELECT rowid, rank
            FROM chunks_fts
            WHERE chunks_fts MATCH ?
            ORDER BY rank
            LIMIT ?
        """, (query, limit)).fetchall()
        return [(row[0], -row[1]) for row in rows]  # FTS5 rank is negative (lower=better)
    except Exception:
        return []


def vector_search(conn, query_embedding: np.ndarray, limit: int = 50, role_filter: str = None) -> list:
    """Vectorized cosine similarity search. Returns [(chunk_id, score), ...]"""
    if role_filter:
        rows = conn.execute("""
            SELECT e.chunk_id, e.embedding FROM embeddings e
            JOIN chunks c ON c.id = e.chunk_id
            WHERE c.roles = ? OR c.roles = 'both'
        """, (role_filter,)).fetchall()
    else:
        rows = conn.execute("SELECT chunk_id, embedding FROM embeddings").fetchall()

    if not rows:
        return []

    chunk_ids = [r[0] for r in rows]
    # Batch decode + matrix multiply (much faster than loop)
    dim = len(query_embedding)
    matrix = np.frombuffer(b"".join(r[1] for r in rows), dtype=np.float32).reshape(-1, dim)
    norms = np.linalg.norm(matrix, axis=1)
    norms[norms == 0] = 1e-10
    scores = matrix @ query_embedding / (norms * np.linalg.norm(query_embedding))

    top_idx = np.argsort(scores)[-limit:][::-1]
    return [(chunk_ids[i], float(scores[i])) for i in top_idx]


def reciprocal_rank_fusion(result_lists: list, weights: list, k: int = RRF_K) -> list:
    """
    Combine multiple ranked lists using weighted RRF.
    result_lists: [[(id, score), ...], ...]
    weights: [float, ...]
    Returns: [(id, fused_score), ...] sorted desc
    """
    scores = {}
    for results, weight in zip(result_lists, weights):
        for rank, (item_id, _) in enumerate(results):
            if item_id not in scores:
                scores[item_id] = 0.0
            scores[item_id] += weight * (1.0 / (k + rank + 1))

    fused = sorted(scores.items(), key=lambda x: x[1], reverse=True)
    return fused


def recency_score(create_time: float, now_ts: float = None) -> float:
    """Exponential decay recency boost. Recent = higher score."""
    if not create_time:
        return 0.0
    if now_ts is None:
        now_ts = time.time()
    age_days = max(0, (now_ts - create_time) / 86400)
    return RECENCY_BOOST_MAX * (0.5 ** (age_days / RECENCY_HALF_LIFE_DAYS))


def mmr_rerank(candidates: list, embeddings_map: dict, query_embedding: np.ndarray,
               top_n: int, lambda_param: float = MMR_LAMBDA) -> list:
    """
    Maximal Marginal Relevance: diversify results by penalizing
    similarity to already-selected results.

    candidates: [(chunk_id, score), ...]
    embeddings_map: {chunk_id: np.ndarray}
    Returns: [(chunk_id, score), ...] reranked
    """
    if len(candidates) <= top_n:
        return candidates

    selected = []
    remaining = list(candidates)

    while len(selected) < top_n and remaining:
        best_idx = -1
        best_mmr = -float("inf")

        for i, (cid, rel_score) in enumerate(remaining):
            emb = embeddings_map.get(cid)
            if emb is None:
                continue

            # Max similarity to already selected
            if selected:
                sel_embs = [embeddings_map[s[0]] for s in selected if s[0] in embeddings_map]
                if sel_embs:
                    sel_matrix = np.array(sel_embs)
                    sims = sel_matrix @ emb / (np.linalg.norm(sel_matrix, axis=1) * np.linalg.norm(emb) + 1e-10)
                    max_sim = float(np.max(sims))
                else:
                    max_sim = 0.0
            else:
                max_sim = 0.0

            mmr = lambda_param * rel_score - (1 - lambda_param) * max_sim
            if mmr > best_mmr:
                best_mmr = mmr
                best_idx = i

        if best_idx >= 0:
            selected.append(remaining.pop(best_idx))
        else:
            break

    return selected


def get_context_chunks(conn, chunk_id: int, window: int = 1) -> list:
    """Get surrounding chunks from the same conversation for context."""
    row = conn.execute(
        "SELECT conversation_id, chunk_index FROM chunks WHERE id = ?", (chunk_id,)
    ).fetchone()
    if not row:
        return []
    conv_id, idx = row
    rows = conn.execute("""
        SELECT id, chunk_index, content, metadata_header
        FROM chunks
        WHERE conversation_id = ? AND chunk_index BETWEEN ? AND ?
        ORDER BY chunk_index
    """, (conv_id, idx - window, idx + window)).fetchall()
    return [{"id": r[0], "chunk_index": r[1], "content": r[2], "header": r[3]} for r in rows]


# ── Commands ─────────────────────────────────────────────

def cmd_chunk(args):
    conn = get_db(args.db)

    existing = 0
    try:
        existing = conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
    except:
        pass

    if existing > 0 and not args.force:
        print(f"Already have {existing} chunks. Use --force to re-chunk.")
        conn.close()
        return

    # Full reset
    drop_chunks(conn)
    init_schema(conn)

    convos = conn.execute(
        "SELECT id, title, create_time FROM conversations ORDER BY create_time"
    ).fetchall()
    print(f"Chunking {len(convos)} conversations...", flush=True)

    total_chunks = 0
    for idx, (conv_id, title, ctime) in enumerate(convos):
        msgs = conn.execute(
            "SELECT role, content, create_time FROM messages WHERE conversation_id = ? ORDER BY seq",
            (conv_id,)
        ).fetchall()

        chunks = chunk_conversation(conv_id, title, ctime, msgs)
        for c in chunks:
            conn.execute(
                """INSERT INTO chunks
                   (conversation_id, conversation_title, chunk_index, total_chunks,
                    content, metadata_header, roles, token_estimate, create_time, date_str)
                   VALUES (?,?,?,?,?,?,?,?,?,?)""",
                (c["conversation_id"], c["conversation_title"], c["chunk_index"],
                 c["total_chunks"], c["content"], c["metadata_header"], c["roles"],
                 c["token_estimate"], c["create_time"], c["date_str"])
            )
            total_chunks += 1

        if (idx + 1) % 100 == 0:
            conn.commit()
            print(f"  {idx+1}/{len(convos)}: {total_chunks} chunks", flush=True)

    conn.commit()

    # Stats
    total_tokens = conn.execute("SELECT SUM(token_estimate) FROM chunks").fetchone()[0] or 0
    avg_tokens = conn.execute("SELECT AVG(token_estimate) FROM chunks").fetchone()[0] or 0
    min_tokens = conn.execute("SELECT MIN(token_estimate) FROM chunks").fetchone()[0] or 0
    max_tokens = conn.execute("SELECT MAX(token_estimate) FROM chunks").fetchone()[0] or 0

    print(f"\nDone: {total_chunks} chunks from {len(convos)} conversations")
    print(f"Tokens — total: {total_tokens:,} | avg: {avg_tokens:.0f} | min: {min_tokens} | max: {max_tokens}")
    conn.close()


def cmd_embed(args):
    conn = get_db(args.db)
    init_schema(conn)

    unembedded = conn.execute("""
        SELECT c.id, c.metadata_header, c.content
        FROM chunks c
        LEFT JOIN embeddings e ON e.chunk_id = c.id
        WHERE e.chunk_id IS NULL
    """).fetchall()

    if not unembedded:
        print("All chunks already embedded.")
        conn.close()
        return

    print(f"Embedding {len(unembedded)} chunks (batch size {args.batch_size})...", flush=True)

    total_tokens = 0
    for i in range(0, len(unembedded), args.batch_size):
        batch = unembedded[i:i + args.batch_size]
        bn = i // args.batch_size + 1
        tb = (len(unembedded) + args.batch_size - 1) // args.batch_size

        # Embed with metadata header prepended (key RAG practice)
        texts = [f"{header}\n\n{content}" for _, header, content in batch]
        ids = [r[0] for r in batch]

        print(f"  Batch {bn}/{tb}...", end="", flush=True)
        try:
            embeddings = get_embeddings_batch(texts)
            now = datetime.now(timezone.utc).isoformat()
            for cid, emb in zip(ids, embeddings):
                conn.execute(
                    "INSERT OR REPLACE INTO embeddings VALUES (?,?,?,?)",
                    (cid, embedding_to_blob(emb), "text-embedding-3-small", now)
                )
            conn.commit()
            batch_tokens = sum(estimate_tokens(t) for t in texts)
            total_tokens += batch_tokens
            print(f" ok (~{batch_tokens} tokens)", flush=True)
        except Exception as e:
            print(f" ERROR: {e}", flush=True)
            time.sleep(5)

    cost = total_tokens / 1_000_000 * 0.02
    print(f"\nDone. ~{total_tokens:,} tokens embedded (est: ${cost:.4f})")
    conn.close()


def _do_search(conn, query: str, top_n: int, ledi_only: bool = False):
    """
    Core search logic with:
    - Hybrid BM25 + vector search
    - RRF fusion
    - Recency boost
    - MMR diversity reranking
    - Optional Ledi-voice-only filter

    Returns list of result dicts.
    """
    role_filter = "user" if ledi_only else None
    candidate_pool = top_n * 10  # wider pool for MMR to work with

    # 1. BM25 search
    bm25_results = bm25_search(conn, query, limit=candidate_pool)

    # 2. Vector search
    query_emb = np.array(get_embeddings_batch([query])[0], dtype=np.float32)
    vec_results = vector_search(conn, query_emb, limit=candidate_pool, role_filter=role_filter)

    # 3. RRF fusion
    fused = reciprocal_rank_fusion(
        [vec_results, bm25_results],
        [VECTOR_WEIGHT, BM25_WEIGHT]
    )

    if not fused:
        return []

    # 4. Apply recency boost to fused scores
    now_ts = time.time()
    chunk_times = {}
    all_ids = [cid for cid, _ in fused[:candidate_pool]]
    if all_ids:
        placeholders = ",".join("?" * len(all_ids))
        rows = conn.execute(
            f"SELECT id, create_time FROM chunks WHERE id IN ({placeholders})", all_ids
        ).fetchall()
        chunk_times = {r[0]: r[1] for r in rows}

    boosted = []
    for cid, score in fused[:candidate_pool]:
        boost = recency_score(chunk_times.get(cid), now_ts)
        boosted.append((cid, score + boost))
    boosted.sort(key=lambda x: x[1], reverse=True)

    # 5. MMR diversity reranking
    # Load embeddings for candidates
    candidate_ids = [cid for cid, _ in boosted[:candidate_pool]]
    embeddings_map = {}
    if candidate_ids:
        placeholders = ",".join("?" * len(candidate_ids))
        emb_rows = conn.execute(
            f"SELECT chunk_id, embedding FROM embeddings WHERE chunk_id IN ({placeholders})",
            candidate_ids
        ).fetchall()
        for cid, blob in emb_rows:
            embeddings_map[cid] = blob_to_embedding(blob)

    reranked = mmr_rerank(boosted, embeddings_map, query_emb, top_n)

    # Build score lookups
    vec_scores = {cid: s for cid, s in vec_results}
    bm25_scores = {cid: s for cid, s in bm25_results}
    fused_scores = {cid: s for cid, s in fused}
    boosted_scores = {cid: s for cid, s in boosted}

    results = []
    for rank, (chunk_id, mmr_score) in enumerate(reranked):
        row = conn.execute(
            "SELECT conversation_title, content, metadata_header, date_str, chunk_index, total_chunks, conversation_id, create_time, roles FROM chunks WHERE id = ?",
            (chunk_id,)
        ).fetchone()
        if not row:
            continue

        title, content, header, date_str, cidx, total, conv_id, ctime, roles = row
        rec_boost = recency_score(ctime, now_ts)

        results.append({
            "rank": rank + 1,
            "chunk_id": chunk_id,
            "conversation_id": conv_id,
            "title": title,
            "date": date_str,
            "part": f"{cidx+1}/{total}",
            "content": content,
            "roles": roles,
            "scores": {
                "final": round(mmr_score, 4),
                "rrf": round(fused_scores.get(chunk_id, 0), 4),
                "vector": round(vec_scores.get(chunk_id, 0), 4),
                "bm25": round(bm25_scores.get(chunk_id, 0), 2),
                "recency": round(rec_boost, 4),
            },
        })
    return results


def cmd_search(args):
    conn = get_db(args.db)
    ledi_only = getattr(args, "ledi_only", False)
    results = _do_search(conn, args.query, args.top, ledi_only=ledi_only)

    if not results:
        if args.json:
            print("[]")
        else:
            print("No results found.")
        conn.close()
        return

    if args.json:
        if args.context:
            for r in results:
                ctx = get_context_chunks(conn, r["chunk_id"], window=1)
                r["context"] = [{"chunk_index": c["chunk_index"], "content": c["content"]} for c in ctx]
        print(json.dumps(results, indent=2))
        conn.close()
        return

    # Human-readable output
    mode_label = "Ledi-only" if ledi_only else "all roles"
    print(f'Search: "{args.query}" ({mode_label})')
    print(f"Method: hybrid BM25+vector → RRF → recency boost → MMR diversity\n")

    for r in results:
        s = r["scores"]
        print(f"{'━' * 70}")
        print(f"#{r['rank']}  {r['title']}  |  {r['date']}  |  part {r['part']}  |  {r['roles']}")
        print(f"     final: {s['final']:.4f}  (vec: {s['vector']:.4f}  bm25: {s['bm25']:.2f}  recency: +{s['recency']:.4f})")
        print(f"{'━' * 70}")

        if args.context:
            ctx = get_context_chunks(conn, r["chunk_id"], window=1)
            for c in ctx:
                marker = " ◀ MATCH" if c["id"] == r["chunk_id"] else ""
                print(f"\n--- chunk {c['chunk_index']}{marker} ---")
                print(c["content"][:600])
                if len(c["content"]) > 600:
                    print("...[truncated]")
        else:
            preview = r["content"][:500]
            if len(r["content"]) > 500:
                preview += "...[truncated]"
            print(preview)
        print()

    conn.close()


def cmd_stats(args):
    conn = get_db(args.db)

    convos = conn.execute("SELECT COUNT(*) FROM conversations").fetchone()[0]
    msgs = conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
    user_msgs = conn.execute("SELECT COUNT(*) FROM messages WHERE role='user'").fetchone()[0]

    chunks = embedded = 0
    avg_tok = min_tok = max_tok = total_tok = 0
    try:
        chunks = conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
        embedded = conn.execute("SELECT COUNT(*) FROM embeddings").fetchone()[0]
        if chunks:
            total_tok = conn.execute("SELECT SUM(token_estimate) FROM chunks").fetchone()[0] or 0
            avg_tok = conn.execute("SELECT AVG(token_estimate) FROM chunks").fetchone()[0] or 0
            min_tok = conn.execute("SELECT MIN(token_estimate) FROM chunks").fetchone()[0] or 0
            max_tok = conn.execute("SELECT MAX(token_estimate) FROM chunks").fetchone()[0] or 0
    except:
        pass

    date_range = conn.execute(
        "SELECT MIN(create_time), MAX(create_time) FROM conversations WHERE create_time IS NOT NULL"
    ).fetchone()

    print(f"Conversations:  {convos}")
    print(f"Messages:       {msgs} ({user_msgs} from Ledi)")
    print(f"Chunks:         {chunks}")
    print(f"Embedded:       {embedded}/{chunks}")
    if chunks:
        print(f"Tokens (est):   {total_tok:,} total | avg {avg_tok:.0f} | min {min_tok} | max {max_tok}")
    if date_range[0]:
        print(f"Date range:     {ts_to_date(date_range[0])} → {ts_to_date(date_range[1])}")

    # Role distribution
    try:
        roles = conn.execute(
            "SELECT roles, COUNT(*) FROM chunks GROUP BY roles ORDER BY COUNT(*) DESC"
        ).fetchall()
        print(f"\nChunk roles:")
        for r, c in roles:
            print(f"  {r}: {c}")
    except:
        pass

    conn.close()


# ── Topic Tagging ────────────────────────────────────────

TOPIC_TAXONOMY = [
    "business_strategy", "business_finance", "business_operations",
    "marketing", "social_media", "content_creation", "branding",
    "sales", "client_work", "coaching",
    "personal_finance", "household", "parenting", "family",
    "spirituality", "astrology", "self_development", "health",
    "relationships", "identity", "emotions",
    "technology", "ai", "automation",
    "style_beauty", "food_cooking", "shopping",
    "career", "education", "other"
]


def cmd_tag(args):
    """Auto-tag conversations with topics using LLM classification."""
    import openai
    client = openai.OpenAI(api_key=os.environ["OPENAI_API_KEY"])
    conn = get_db(args.db)

    # Ensure table exists
    conn.execute("""
        CREATE TABLE IF NOT EXISTS conversation_topics (
            conversation_id TEXT NOT NULL,
            topic TEXT NOT NULL,
            confidence REAL DEFAULT 1.0,
            PRIMARY KEY (conversation_id, topic),
            FOREIGN KEY (conversation_id) REFERENCES conversations(id)
        )
    """)
    conn.commit()

    # Get conversations to tag
    if args.force:
        conn.execute("DELETE FROM conversation_topics")
        conn.commit()
        convos = conn.execute(
            "SELECT id, title FROM conversations ORDER BY create_time"
        ).fetchall()
    else:
        convos = conn.execute("""
            SELECT c.id, c.title FROM conversations c
            WHERE c.id NOT IN (SELECT DISTINCT conversation_id FROM conversation_topics)
            ORDER BY c.create_time
        """).fetchall()

    if not convos:
        print("All conversations already tagged.")
        existing = conn.execute("SELECT COUNT(DISTINCT conversation_id) FROM conversation_topics").fetchone()[0]
        topics = conn.execute("SELECT topic, COUNT(*) FROM conversation_topics GROUP BY topic ORDER BY COUNT(*) DESC").fetchall()
        print(f"\n{existing} conversations tagged across {len(topics)} topics:")
        for t, c in topics:
            print(f"  {t}: {c}")
        conn.close()
        return

    print(f"Tagging {len(convos)} conversations...", flush=True)
    taxonomy_str = ", ".join(TOPIC_TAXONOMY)

    total_tagged = 0
    for i in range(0, len(convos), args.batch_size):
        batch = convos[i:i + args.batch_size]
        bn = i // args.batch_size + 1
        tb = (len(convos) + args.batch_size - 1) // args.batch_size

        # For each conversation, get first few user messages as signal
        batch_items = []
        for conv_id, title in batch:
            user_msgs = conn.execute("""
                SELECT content FROM messages
                WHERE conversation_id = ? AND role = 'user'
                ORDER BY seq LIMIT 5
            """, (conv_id,)).fetchall()
            preview = " | ".join(m[0][:200] for m in user_msgs if m[0])
            if not preview:
                # Use assistant messages as fallback
                asst_msgs = conn.execute("""
                    SELECT content FROM messages
                    WHERE conversation_id = ? AND role = 'assistant'
                    ORDER BY seq LIMIT 3
                """, (conv_id,)).fetchall()
                preview = " | ".join(m[0][:200] for m in asst_msgs if m[0])
            batch_items.append({"id": conv_id, "title": title, "preview": preview[:500]})

        prompt = f"""Classify each conversation into 1-3 topics from this taxonomy:
{taxonomy_str}

Return ONLY a JSON array. Each element: {{"id": "...", "topics": ["topic1", "topic2"]}}

Conversations:
"""
        for item in batch_items:
            prompt += f'\n- id: {item["id"]}\n  title: {item["title"]}\n  preview: {item["preview"][:300]}\n'

        print(f"  Batch {bn}/{tb} ({len(batch)} convos)...", end="", flush=True)

        try:
            resp = client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[
                    {"role": "system", "content": "You are a conversation classifier. Return only valid JSON arrays."},
                    {"role": "user", "content": prompt}
                ],
                temperature=0.1,
                response_format={"type": "json_object"},
            )
            raw = resp.choices[0].message.content
            parsed = json.loads(raw)

            # Handle both {"results": [...]} and direct [...]
            if isinstance(parsed, dict):
                items = parsed.get("results") or parsed.get("conversations") or parsed.get("data") or list(parsed.values())[0]
            else:
                items = parsed

            for item in items:
                cid = item.get("id", "")
                topics = item.get("topics", [])
                for topic in topics:
                    topic = topic.strip().lower().replace(" ", "_")
                    if topic in TOPIC_TAXONOMY:
                        conn.execute(
                            "INSERT OR IGNORE INTO conversation_topics (conversation_id, topic) VALUES (?, ?)",
                            (cid, topic)
                        )
                        total_tagged += 1

            conn.commit()
            print(f" ok ({len(items)} classified)", flush=True)

        except Exception as e:
            print(f" ERROR: {e}", flush=True)
            time.sleep(2)

    # Summary
    topics = conn.execute(
        "SELECT topic, COUNT(*) FROM conversation_topics GROUP BY topic ORDER BY COUNT(*) DESC"
    ).fetchall()
    tagged_convos = conn.execute("SELECT COUNT(DISTINCT conversation_id) FROM conversation_topics").fetchone()[0]

    print(f"\nDone. {tagged_convos} conversations tagged, {total_tagged} topic assignments")
    print("\nTopic distribution:")
    for t, c in topics:
        bar = "█" * (c // 3)
        print(f"  {t:25s} {c:>4}  {bar}")

    conn.close()


# ── Main ─────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="ChatGPT RAG pipeline")
    parser.add_argument("--db", default=DB_DEFAULT)
    sub = parser.add_subparsers(dest="command")

    p_chunk = sub.add_parser("chunk")
    p_chunk.add_argument("--force", action="store_true")

    p_embed = sub.add_parser("embed")
    p_embed.add_argument("--batch-size", type=int, default=100)

    p_search = sub.add_parser("search")
    p_search.add_argument("query")
    p_search.add_argument("--top", type=int, default=5)
    p_search.add_argument("--context", action="store_true", help="Show surrounding chunks")
    p_search.add_argument("--json", action="store_true", help="Output JSON for programmatic use")
    p_search.add_argument("--ledi-only", action="store_true", help="Only search chunks containing Ledi's voice")

    sub.add_parser("stats")

    p_tag = sub.add_parser("tag", help="Auto-tag conversations with topics")
    p_tag.add_argument("--batch-size", type=int, default=20)
    p_tag.add_argument("--force", action="store_true")

    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        return

    cmds = {"chunk": cmd_chunk, "embed": cmd_embed, "search": cmd_search, "stats": cmd_stats, "tag": cmd_tag}
    cmds[args.command](args)


if __name__ == "__main__":
    main()
