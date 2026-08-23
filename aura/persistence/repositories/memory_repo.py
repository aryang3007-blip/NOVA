"""
AURA :: Memory Repository
=========================
Manages conversation turns, user preference facts, knowledge documents,
vector embeddings with local cosine similarity search, episodic memories,
and face landmark biometric signatures.
"""

import json
import math
import struct
import time
from typing import Any, Dict, List, Optional, Tuple
from ..db import db_manager


class MemoryRepository:
    def __init__(self, manager=None):
        self.manager = manager or db_manager

    # ── CONVERSATION MESSAGES ─────────────────────────────────────────

    def add_message(self, role: str, content: str, session_id: str = "default",
                    pinned: bool = False, msg_id: Optional[str] = None) -> Dict[str, Any]:
        conn = self.manager.get_connection()
        now = time.time()
        mid = msg_id or f"{int(now * 1000)}-{role}"
        with conn:
            conn.execute(
                """
                INSERT INTO conversation_messages (id, session_id, role, content, pinned, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    content = excluded.content,
                    pinned = excluded.pinned;
                """,
                (mid, session_id, role, str(content), 1 if pinned else 0, now)
            )
        return {"id": mid, "sessionId": session_id, "role": role, "content": content, "pinned": pinned, "t": now}

    def get_messages(self, session_id: Optional[str] = None, limit: int = 160) -> List[Dict[str, Any]]:
        conn = self.manager.get_connection()
        cursor = conn.cursor()
        if session_id:
            cursor.execute(
                """
                SELECT id, session_id, role, content, pinned, edited_at, created_at
                FROM conversation_messages
                WHERE session_id = ?
                ORDER BY created_at ASC
                LIMIT ?;
                """,
                (session_id, limit)
            )
        else:
            cursor.execute(
                """
                SELECT id, session_id, role, content, pinned, edited_at, created_at
                FROM conversation_messages
                ORDER BY created_at ASC
                LIMIT ?;
                """,
                (limit,)
            )
        out = []
        for r in cursor.fetchall():
            out.append({
                "id": r["id"],
                "sessionId": r["session_id"],
                "role": r["role"],
                "content": r["content"],
                "pinned": bool(r["pinned"]),
                "edited": r["edited_at"],
                "t": int(r["created_at"] * 1000) if r["created_at"] < 1e11 else int(r["created_at"])
            })
        return out

    def get_conversation_window(self, max_turns: int = 20) -> List[Dict[str, str]]:
        """Get rolling window of recent turns plus all pinned messages in chronological order."""
        messages = self.get_messages(limit=300)
        recent = messages[-max_turns * 2:]
        pins = [m for m in messages if m["pinned"] and m not in recent]
        merged = pins + recent
        return [{"role": m["role"], "content": m["content"]} for m in merged]

    def set_pinned(self, msg_id: str, pinned: bool = True) -> bool:
        conn = self.manager.get_connection()
        with conn:
            cursor = conn.execute("UPDATE conversation_messages SET pinned = ? WHERE id = ?;", (1 if pinned else 0, msg_id))
            return cursor.rowcount > 0

    def edit_message(self, msg_id: str, content: str) -> bool:
        conn = self.manager.get_connection()
        with conn:
            cursor = conn.execute(
                "UPDATE conversation_messages SET content = ?, edited_at = ? WHERE id = ?;",
                (str(content), time.time(), msg_id)
            )
            return cursor.rowcount > 0

    def delete_message(self, msg_id: str) -> bool:
        conn = self.manager.get_connection()
        with conn:
            cursor = conn.execute("DELETE FROM conversation_messages WHERE id = ?;", (msg_id,))
            return cursor.rowcount > 0

    def clear_conversation(self, session_id: Optional[str] = None) -> bool:
        conn = self.manager.get_connection()
        with conn:
            if session_id:
                conn.execute("DELETE FROM conversation_messages WHERE session_id = ?;", (session_id,))
            else:
                conn.execute("DELETE FROM conversation_messages;")
        return True

    # ── USER PREFERENCES ──────────────────────────────────────────────

    def set_preference(self, key: str, value: Any, source: str = "user", confidence: float = 1.0) -> bool:
        conn = self.manager.get_connection()
        val_json = json.dumps(value)
        now = time.time()
        with conn:
            conn.execute(
                """
                INSERT INTO user_preferences (key, value, source, confidence, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                    value = excluded.value,
                    source = excluded.source,
                    confidence = excluded.confidence,
                    updated_at = excluded.updated_at;
                """,
                (key, val_json, source, float(confidence), now, now)
            )
        return True

    def get_preference(self, key: str, default: Any = None) -> Any:
        conn = self.manager.get_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT value FROM user_preferences WHERE key = ?;", (key,))
        row = cursor.fetchone()
        if not row:
            return default
        try:
            return json.loads(row["value"])
        except Exception:
            return row["value"]

    def get_all_preferences(self) -> Dict[str, Dict[str, Any]]:
        conn = self.manager.get_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT key, value, source, confidence, updated_at FROM user_preferences;")
        out = {}
        for r in cursor.fetchall():
            try:
                v = json.loads(r["value"])
            except Exception:
                v = r["value"]
            out[r["key"]] = {
                "value": v,
                "source": r["source"],
                "confidence": r["confidence"],
                "at": int(r["updated_at"] * 1000)
            }
        return out

    def delete_preference(self, key: str) -> bool:
        conn = self.manager.get_connection()
        with conn:
            cursor = conn.execute("DELETE FROM user_preferences WHERE key = ?;", (key,))
            return cursor.rowcount > 0

    def clear_preferences(self) -> bool:
        conn = self.manager.get_connection()
        with conn:
            conn.execute("DELETE FROM user_preferences;")
        return True

    # ── KNOWLEDGE & VECTOR EMBEDDINGS ─────────────────────────────────

    def add_knowledge_doc(self, doc_id: str, text: str, title: Optional[str] = None,
                          source: str = "user", tags: Optional[List[str]] = None,
                          embedding: Optional[List[float]] = None,
                          embed_model: str = "local") -> Dict[str, Any]:
        conn = self.manager.get_connection()
        now = time.time()
        tags_json = json.dumps(tags or [])
        meta_json = json.dumps({"title": title, "source": source, "tags": tags or [], "at": now})

        with conn:
            conn.execute(
                """
                INSERT INTO knowledge_documents (id, title, text, source, tags, metadata, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    title = excluded.title,
                    text = excluded.text,
                    tags = excluded.tags,
                    metadata = excluded.metadata,
                    updated_at = excluded.updated_at;
                """,
                (doc_id, title, str(text), source, tags_json, meta_json, now, now)
            )
            if embedding and isinstance(embedding, list) and len(embedding) > 0:
                blob = struct.pack(f"{len(embedding)}f", *embedding)
                conn.execute(
                    """
                    INSERT INTO document_embeddings (doc_id, model, dimensions, embedding, created_at)
                    VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(doc_id) DO UPDATE SET
                        model = excluded.model,
                        dimensions = excluded.dimensions,
                        embedding = excluded.embedding,
                        created_at = excluded.created_at;
                    """,
                    (doc_id, embed_model, len(embedding), blob, now)
                )

        return {"id": doc_id, "text": text, "title": title, "source": source, "tags": tags or []}

    def get_all_knowledge_docs(self) -> List[Dict[str, Any]]:
        conn = self.manager.get_connection()
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT k.id, k.title, k.text, k.source, k.tags, k.metadata, k.created_at,
                   e.dimensions, e.embedding
            FROM knowledge_documents k
            LEFT JOIN document_embeddings e ON k.id = e.doc_id
            ORDER BY k.created_at DESC;
            """
        )
        out = []
        for r in cursor.fetchall():
            emb = None
            if r["embedding"] and r["dimensions"]:
                try:
                    emb = list(struct.unpack(f"{r['dimensions']}f", r["embedding"]))
                except Exception:
                    emb = None
            try:
                meta = json.loads(r["metadata"]) if r["metadata"] else {}
            except Exception:
                meta = {}
            out.append({
                "id": r["id"],
                "text": r["text"],
                "title": r["title"],
                "source": r["source"],
                "tags": json.loads(r["tags"]) if r["tags"] else [],
                "metadata": meta,
                "embedding": emb,
                "at": int(r["created_at"] * 1000)
            })
        return out

    def search_knowledge(self, query: str, query_vector: Optional[List[float]] = None,
                         limit: int = 5, min_score: float = 0.05) -> List[Dict[str, Any]]:
        """
        Search knowledge base using cosine similarity over embeddings if vector provided,
        or keyword token overlap.
        """
        docs = self.get_all_knowledge_docs()
        if not docs:
            return []

        # Vector search
        if query_vector and len(query_vector) > 0:
            scored = []
            qv_norm = math.sqrt(sum(x * x for x in query_vector))
            if qv_norm > 0:
                for d in docs:
                    dv = d.get("embedding")
                    if dv and len(dv) == len(query_vector):
                        dot = sum(a * b for a, b in zip(query_vector, dv))
                        dv_norm = math.sqrt(sum(x * x for x in dv))
                        if dv_norm > 0:
                            sim = dot / (qv_norm * dv_norm)
                            if sim >= max(min_score, 0.45):
                                scored.append({"doc": d, "score": sim})
                if scored:
                    scored.sort(key=lambda x: x["score"], reverse=True)
                    return scored[:limit]

        # Keyword fallback
        q_tokens = set(query.lower().split())
        scored_kw = []
        for d in docs:
            d_tokens = set(d["text"].lower().split())
            overlap = len(q_tokens.intersection(d_tokens))
            if overlap > 0:
                score = overlap / math.sqrt(max(1, len(q_tokens) * len(d_tokens)))
                if score >= min_score:
                    scored_kw.append({"doc": d, "score": score})
        scored_kw.sort(key=lambda x: x["score"], reverse=True)
        return scored_kw[:limit]

    def delete_knowledge_doc(self, doc_id: str) -> bool:
        conn = self.manager.get_connection()
        with conn:
            cursor = conn.execute("DELETE FROM knowledge_documents WHERE id = ?;", (doc_id,))
            return cursor.rowcount > 0

    def clear_knowledge(self) -> bool:
        conn = self.manager.get_connection()
        with conn:
            conn.execute("DELETE FROM knowledge_documents;")
        return True

    # ── EPISODIC MEMORIES ─────────────────────────────────────────────

    def record_episode(self, event: str, why: str = "", source: str = "cognitive-orchestrator",
                       ep_id: Optional[str] = None) -> Dict[str, Any]:
        conn = self.manager.get_connection()
        now = time.time()
        eid = ep_id or f"ep_{int(now * 1000)}"
        with conn:
            conn.execute(
                """
                INSERT INTO episodic_memories (id, event, why, source, created_at)
                VALUES (?, ?, ?, ?, ?);
                """,
                (eid, str(event), str(why), str(source), now)
            )
        return {"id": eid, "event": event, "why": why, "source": source, "at": int(now * 1000)}

    def get_episodes(self, limit: int = 100) -> List[Dict[str, Any]]:
        conn = self.manager.get_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT id, event, why, source, created_at FROM episodic_memories ORDER BY created_at DESC LIMIT ?;", (limit,))
        out = []
        for r in cursor.fetchall():
            out.append({
                "id": r["id"],
                "event": r["event"],
                "why": r["why"],
                "source": r["source"],
                "at": int(r["created_at"] * 1000)
            })
        return out

    def clear_episodes(self) -> bool:
        conn = self.manager.get_connection()
        with conn:
            conn.execute("DELETE FROM episodic_memories;")
        return True

    # ── USER IDENTITIES (FACE SIGNATURES) ──────────────────────────────

    def save_identity(self, name: str, signature: List[float], ident_id: Optional[str] = None) -> Dict[str, Any]:
        conn = self.manager.get_connection()
        now = time.time()
        iid = ident_id or f"face_{int(now * 1000)}"
        sig_json = json.dumps(signature)
        with conn:
            conn.execute(
                """
                INSERT INTO user_identities (id, name, signature, samples_count, enrolled_at, updated_at)
                VALUES (?, ?, ?, 3, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    signature = excluded.signature,
                    updated_at = excluded.updated_at;
                """,
                (iid, name, sig_json, now, now)
            )
        return {"id": iid, "name": name, "signature": signature, "enrolledAt": now}

    def get_identities(self) -> List[Dict[str, Any]]:
        conn = self.manager.get_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT id, name, signature, samples_count, enrolled_at FROM user_identities;")
        out = []
        for r in cursor.fetchall():
            try:
                sig = json.loads(r["signature"])
            except Exception:
                sig = []
            out.append({
                "id": r["id"],
                "name": r["name"],
                "signature": sig,
                "samplesCount": r["samples_count"],
                "enrolledAt": r["enrolled_at"]
            })
        return out

    def delete_identity(self, ident_id: str) -> bool:
        conn = self.manager.get_connection()
        with conn:
            cursor = conn.execute("DELETE FROM user_identities WHERE id = ?;", (ident_id,))
            return cursor.rowcount > 0


memory_repo = MemoryRepository()
