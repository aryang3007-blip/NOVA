"""
AURA :: Wake Phrase Repository
==============================
Manages wake words, thresholds, models, and activation states in SQLite.
"""

import time
from typing import Any, Dict, List, Optional
from ..db import db_manager


class WakePhraseRepository:
    def __init__(self, manager=None):
        self.manager = manager or db_manager

    def set_phrase(self, phrase_id: str, name: str, phrase: str,
                   model: Optional[str] = None, threshold: float = 0.55,
                   enabled: bool = True) -> Dict[str, Any]:
        conn = self.manager.get_connection()
        now = time.time()
        with conn:
            conn.execute(
                """
                INSERT INTO wake_phrases (id, name, phrase, model, threshold, enabled, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    phrase = excluded.phrase,
                    model = excluded.model,
                    threshold = excluded.threshold,
                    enabled = excluded.enabled,
                    updated_at = excluded.updated_at;
                """,
                (phrase_id, name, phrase.lower().strip(), model, float(threshold), 1 if enabled else 0, now)
            )
        return {
            "id": phrase_id, "name": name, "phrase": phrase.lower().strip(),
            "model": model, "threshold": threshold, "enabled": enabled
        }

    def get_all_phrases(self) -> List[Dict[str, Any]]:
        conn = self.manager.get_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT id, name, phrase, model, threshold, enabled, updated_at FROM wake_phrases;")
        out = []
        for r in cursor.fetchall():
            out.append({
                "id": r["id"],
                "name": r["name"],
                "phrase": r["phrase"],
                "model": r["model"],
                "threshold": r["threshold"],
                "enabled": bool(r["enabled"]),
                "updatedAt": r["updated_at"]
            })
        return out

    def get_active_phrases(self) -> List[Dict[str, Any]]:
        conn = self.manager.get_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT id, name, phrase, model, threshold, enabled FROM wake_phrases WHERE enabled = 1;")
        return [
            {
                "id": r["id"],
                "name": r["name"],
                "phrase": r["phrase"],
                "model": r["model"],
                "threshold": r["threshold"],
                "enabled": True
            }
            for r in cursor.fetchall()
        ]

    def delete_phrase(self, phrase_id: str) -> bool:
        conn = self.manager.get_connection()
        with conn:
            cursor = conn.execute("DELETE FROM wake_phrases WHERE id = ?;", (phrase_id,))
            return cursor.rowcount > 0


wake_repo = WakePhraseRepository()
