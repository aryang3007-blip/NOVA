"""
AURA :: Permission Repository
=============================
Manages desktop security capability grants in SQLite.
"""

import time
from typing import Any, Dict, List
from ..db import db_manager


class PermissionRepository:
    def __init__(self, manager=None):
        self.manager = manager or db_manager

    def set_permission(self, perm_id: str, granted: bool, source: str = "user") -> bool:
        conn = self.manager.get_connection()
        now = time.time()
        with conn:
            conn.execute(
                """
                INSERT INTO permissions (id, granted, source, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    granted = excluded.granted,
                    source = excluded.source,
                    updated_at = excluded.updated_at;
                """,
                (perm_id, 1 if granted else 0, source, now)
            )
        return True

    def get_all_permissions(self) -> Dict[str, Dict[str, Any]]:
        conn = self.manager.get_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT id, granted, source, updated_at FROM permissions;")
        out = {}
        for r in cursor.fetchall():
            out[r["id"]] = {
                "granted": bool(r["granted"]),
                "source": r["source"],
                "at": int(r["updated_at"] * 1000)
            }
        return out

    def is_granted(self, perm_id: str) -> bool:
        conn = self.manager.get_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT granted FROM permissions WHERE id = ?;", (perm_id,))
        r = cursor.fetchone()
        return bool(r["granted"]) if r else False

    def revoke_all(self, source: str = "user") -> bool:
        conn = self.manager.get_connection()
        now = time.time()
        with conn:
            conn.execute("UPDATE permissions SET granted = 0, source = ?, updated_at = ?;", (source, now))
        return True


permission_repo = PermissionRepository()
