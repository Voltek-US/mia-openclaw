#!/usr/bin/env python3
"""
Import Ledi's ChatGPT export into SQLite for analysis.
Phase 1: Raw import of conversations and messages.

Usage:
    python3 import-chatgpt.py <export_dir> [--db <path>]

Default DB: ~/.openclaw/ledi/ledi-chatgpt.sqlite
"""

import argparse
import glob
import json
import os
import sqlite3
import sys
from datetime import datetime, timezone


def init_db(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")

    conn.executescript("""
        CREATE TABLE IF NOT EXISTS conversations (
            id TEXT PRIMARY KEY,
            title TEXT,
            create_time REAL,
            update_time REAL,
            model_slug TEXT,
            gizmo_id TEXT,
            is_archived INTEGER DEFAULT 0,
            message_count INTEGER DEFAULT 0,
            created_at TEXT,
            updated_at TEXT
        );

        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL,
            parent_id TEXT,
            role TEXT,           -- 'user', 'assistant', 'system', 'tool'
            content_type TEXT,   -- 'text', 'multimodal_text', 'code', etc.
            content TEXT,        -- extracted text content
            create_time REAL,
            model_slug TEXT,
            seq INTEGER,         -- order within conversation
            FOREIGN KEY (conversation_id) REFERENCES conversations(id)
        );

        CREATE INDEX IF NOT EXISTS idx_messages_convo ON messages(conversation_id);
        CREATE INDEX IF NOT EXISTS idx_messages_role ON messages(role);
        CREATE INDEX IF NOT EXISTS idx_conversations_time ON conversations(create_time);

        -- Phase 2 tables (created now, populated later)
        CREATE TABLE IF NOT EXISTS conversation_topics (
            conversation_id TEXT NOT NULL,
            topic TEXT NOT NULL,
            confidence REAL DEFAULT 1.0,
            FOREIGN KEY (conversation_id) REFERENCES conversations(id),
            PRIMARY KEY (conversation_id, topic)
        );

        CREATE TABLE IF NOT EXISTS insights (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id TEXT,
            category TEXT,       -- 'preference', 'decision', 'goal', 'belief', 'habit', 'relationship', 'business', 'emotion'
            content TEXT NOT NULL,
            source_quote TEXT,   -- original text that led to insight
            extracted_at TEXT,
            FOREIGN KEY (conversation_id) REFERENCES conversations(id)
        );

        CREATE INDEX IF NOT EXISTS idx_insights_category ON insights(category);
    """)
    conn.commit()
    return conn


def extract_text(content: dict) -> str:
    """Extract text from a ChatGPT message content object."""
    parts = content.get("parts", [])
    texts = []
    for part in parts:
        if isinstance(part, str):
            texts.append(part)
        elif isinstance(part, dict):
            # Could be image, file ref, etc.
            if "text" in part:
                texts.append(part["text"])
            elif "content_type" in part:
                texts.append(f"[{part['content_type']}]")
    return "\n".join(texts)


def walk_messages(mapping: dict) -> list:
    """Walk the conversation tree in order, returning messages."""
    # Find root node (no parent)
    root_id = None
    for node_id, node in mapping.items():
        if node.get("parent") is None:
            root_id = node_id
            break

    if not root_id:
        return []

    # Walk children in order
    messages = []
    seq = 0
    queue = [root_id]

    while queue:
        node_id = queue.pop(0)
        node = mapping.get(node_id)
        if not node:
            continue

        msg = node.get("message")
        if msg and msg.get("content"):
            content = msg["content"]
            text = extract_text(content)
            if text.strip():
                messages.append({
                    "id": msg.get("id", node_id),
                    "parent_id": node.get("parent"),
                    "role": msg.get("author", {}).get("role", "unknown"),
                    "content_type": content.get("content_type", "unknown"),
                    "content": text,
                    "create_time": msg.get("create_time"),
                    "model_slug": msg.get("metadata", {}).get("model_slug"),
                    "seq": seq,
                })
                seq += 1

        # Add children to queue
        children = node.get("children", [])
        queue.extend(children)

    return messages


def ts_to_iso(ts):
    if ts:
        try:
            return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()
        except (ValueError, OSError):
            return None
    return None


def import_conversations(export_dir: str, conn: sqlite3.Connection):
    """Import all conversation JSON files."""
    files = sorted(glob.glob(os.path.join(export_dir, "conversations-*.json")))
    if not files:
        print("No conversations-*.json files found!")
        sys.exit(1)

    total_convos = 0
    total_msgs = 0
    skipped = 0

    for filepath in files:
        print(f"Processing {os.path.basename(filepath)}...")
        with open(filepath) as f:
            conversations = json.load(f)

        for conv in conversations:
            conv_id = conv.get("id") or conv.get("conversation_id")
            if not conv_id:
                skipped += 1
                continue

            title = conv.get("title", "Untitled")
            create_time = conv.get("create_time")
            update_time = conv.get("update_time")
            model_slug = conv.get("default_model_slug")
            gizmo_id = conv.get("gizmo_id")
            is_archived = 1 if conv.get("is_archived") else 0

            mapping = conv.get("mapping", {})
            messages = walk_messages(mapping)

            # Insert conversation
            conn.execute("""
                INSERT OR REPLACE INTO conversations
                (id, title, create_time, update_time, model_slug, gizmo_id, is_archived, message_count, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                conv_id, title, create_time, update_time, model_slug,
                gizmo_id, is_archived, len(messages),
                ts_to_iso(create_time), ts_to_iso(update_time)
            ))

            # Insert messages
            for msg in messages:
                conn.execute("""
                    INSERT OR REPLACE INTO messages
                    (id, conversation_id, parent_id, role, content_type, content, create_time, model_slug, seq)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    msg["id"], conv_id, msg["parent_id"], msg["role"],
                    msg["content_type"], msg["content"], msg["create_time"],
                    msg["model_slug"], msg["seq"]
                ))
                total_msgs += 1

            total_convos += 1

        conn.commit()
        print(f"  → {len(conversations)} conversations loaded")

    return total_convos, total_msgs, skipped


def print_summary(conn: sqlite3.Connection):
    """Print import summary stats."""
    stats = {}
    stats["conversations"] = conn.execute("SELECT COUNT(*) FROM conversations").fetchone()[0]
    stats["messages"] = conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
    stats["user_messages"] = conn.execute("SELECT COUNT(*) FROM messages WHERE role='user'").fetchone()[0]
    stats["assistant_messages"] = conn.execute("SELECT COUNT(*) FROM messages WHERE role='assistant'").fetchone()[0]

    row = conn.execute("SELECT MIN(create_time), MAX(create_time) FROM conversations WHERE create_time IS NOT NULL").fetchone()
    if row[0]:
        stats["earliest"] = ts_to_iso(row[0])
        stats["latest"] = ts_to_iso(row[1])

    # Top models
    models = conn.execute("""
        SELECT model_slug, COUNT(*) as cnt
        FROM conversations WHERE model_slug IS NOT NULL
        GROUP BY model_slug ORDER BY cnt DESC LIMIT 5
    """).fetchall()

    # Longest conversations
    longest = conn.execute("""
        SELECT title, message_count FROM conversations
        ORDER BY message_count DESC LIMIT 5
    """).fetchall()

    print("\n" + "=" * 50)
    print("IMPORT SUMMARY")
    print("=" * 50)
    print(f"Conversations: {stats['conversations']}")
    print(f"Total messages: {stats['messages']}")
    print(f"  User messages: {stats['user_messages']}")
    print(f"  Assistant messages: {stats['assistant_messages']}")
    if "earliest" in stats:
        print(f"Date range: {stats['earliest']} → {stats['latest']}")

    if models:
        print("\nTop models:")
        for model, cnt in models:
            print(f"  {model}: {cnt}")

    if longest:
        print("\nLongest conversations:")
        for title, count in longest:
            print(f"  {title}: {count} messages")


def main():
    parser = argparse.ArgumentParser(description="Import ChatGPT export into SQLite")
    parser.add_argument("export_dir", help="Path to extracted ChatGPT export directory")
    parser.add_argument("--db", default=os.path.expanduser("~/.openclaw/ledi/ledi-chatgpt.sqlite"),
                        help="SQLite database path")
    args = parser.parse_args()

    if not os.path.isdir(args.export_dir):
        print(f"Error: {args.export_dir} is not a directory")
        sys.exit(1)

    print(f"DB: {args.db}")
    print(f"Source: {args.export_dir}")
    print()

    conn = init_db(args.db)

    try:
        total_convos, total_msgs, skipped = import_conversations(args.export_dir, conn)
        print_summary(conn)
        if skipped:
            print(f"\nSkipped {skipped} conversations (no ID)")
    finally:
        conn.close()

    print(f"\nDone. DB saved to: {args.db}")


if __name__ == "__main__":
    main()
