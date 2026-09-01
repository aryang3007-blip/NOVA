"""
AURA :: Config Repository
=========================
Manages non-secret user settings and system configuration.
"""

import json
import time
from typing import Any, Dict, Optional
from ..db import db_manager


class ConfigRepository:
    def __init__(self, manager=None):
        self.manager = manager or db_manager

    def get(self, key: str, default: Any = None) -> Any:
        conn = self.manager.get_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT value FROM settings WHERE key = ?;", (key,))
        row = cursor.fetchone()
        if not row:
            return default
        try:
            return json.loads(row["value"])
        except Exception:
            return row["value"]

    def set(self, key: str, value: Any) -> bool:
        conn = self.manager.get_connection()
        val_json = json.dumps(value)
        now = time.time()
        with conn:
            conn.execute(
                """
                INSERT INTO settings (key, value, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                    value = excluded.value,
                    updated_at = excluded.updated_at;
                """,
                (key, val_json, now)
            )
        return True

    def get_all(self) -> Dict[str, Any]:
        conn = self.manager.get_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT key, value FROM settings;")
        out = {}
        for row in cursor.fetchall():
            try:
                out[row["key"]] = json.loads(row["value"])
            except Exception:
                out[row["key"]] = row["value"]
        return out

    def set_many(self, items: Dict[str, Any]) -> bool:
        conn = self.manager.get_connection()
        now = time.time()
        with conn:
            for k, v in items.items():
                val_json = json.dumps(v)
                conn.execute(
                    """
                    INSERT INTO settings (key, value, updated_at)
                    VALUES (?, ?, ?)
                    ON CONFLICT(key) DO UPDATE SET
                        value = excluded.value,
                        updated_at = excluded.updated_at;
                    """,
                    (k, val_json, now)
                )
        return True

    def delete(self, key: str) -> bool:
        conn = self.manager.get_connection()
        with conn:
            cursor = conn.execute("DELETE FROM settings WHERE key = ?;", (key,))
            return cursor.rowcount > 0


config_repo = ConfigRepository()
