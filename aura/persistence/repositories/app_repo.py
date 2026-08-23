"""
AURA :: Application Repository
==============================
Manages installed desktop applications, categories, launchers, executable paths,
and launch statistics.
"""

import json
import time
from typing import Any, Dict, List, Optional
from ..db import db_manager


class AppRepository:
    def __init__(self, manager=None):
        self.manager = manager or db_manager

    def save_app(self, app_id: str, name: str, category: str = "system",
                 icon: str = "📦", aliases: Optional[List[str]] = None,
                 launchers: Optional[Dict[str, Any]] = None,
                 executable_path: Optional[str] = None,
                 web_fallback: Optional[str] = None,
                 verified: bool = False, source: str = "mock",
                 installed: Optional[bool] = True) -> Dict[str, Any]:
        conn = self.manager.get_connection()
        now = time.time()
        aliases_json = json.dumps(aliases or [name.lower()])
        launchers_json = json.dumps(launchers or {})

        with conn:
            conn.execute(
                """
                INSERT INTO installed_applications
                    (id, name, category, icon, aliases, launchers, executable_path, web_fallback,
                     verified, source, installed, launch_count, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    category = excluded.category,
                    icon = excluded.icon,
                    aliases = excluded.aliases,
                    launchers = excluded.launchers,
                    executable_path = coalesce(excluded.executable_path, installed_applications.executable_path),
                    web_fallback = coalesce(excluded.web_fallback, installed_applications.web_fallback),
                    verified = excluded.verified,
                    source = excluded.source,
                    installed = excluded.installed,
                    updated_at = excluded.updated_at;
                """,
                (app_id, name, category, icon, aliases_json, launchers_json,
                 executable_path, web_fallback, 1 if verified else 0, source,
                 1 if installed else (0 if installed is False else None), now, now)
            )
        return {"id": app_id, "name": name, "category": category, "verified": verified, "source": source}

    def record_launch(self, app_id: str) -> bool:
        conn = self.manager.get_connection()
        now = time.time()
        with conn:
            cursor = conn.execute(
                "UPDATE installed_applications SET launch_count = launch_count + 1, last_launched = ?, updated_at = ? WHERE id = ?;",
                (now, now, app_id)
            )
            return cursor.rowcount > 0

    def get_all_apps(self) -> List[Dict[str, Any]]:
        conn = self.manager.get_connection()
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT id, name, category, icon, aliases, launchers, executable_path,
                   web_fallback, verified, source, installed, launch_count, last_launched
            FROM installed_applications
            ORDER BY launch_count DESC, name ASC;
            """
        )
        out = []
        for r in cursor.fetchall():
            out.append({
                "id": r["id"],
                "name": r["name"],
                "category": r["category"],
                "icon": r["icon"],
                "aliases": json.loads(r["aliases"]) if r["aliases"] else [],
                "launchers": json.loads(r["launchers"]) if r["launchers"] else {},
                "executablePath": r["executable_path"],
                "webFallback": r["web_fallback"],
                "verified": bool(r["verified"]),
                "source": r["source"],
                "installed": bool(r["installed"]) if r["installed"] is not None else None,
                "launchCount": r["launch_count"],
                "lastLaunched": r["last_launched"]
            })
        return out

    def get_app(self, app_id: str) -> Optional[Dict[str, Any]]:
        conn = self.manager.get_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM installed_applications WHERE id = ?;", (app_id,))
        r = cursor.fetchone()
        if not r:
            return None
        return {
            "id": r["id"],
            "name": r["name"],
            "category": r["category"],
            "icon": r["icon"],
            "aliases": json.loads(r["aliases"]) if r["aliases"] else [],
            "launchers": json.loads(r["launchers"]) if r["launchers"] else {},
            "executablePath": r["executable_path"],
            "webFallback": r["web_fallback"],
            "verified": bool(r["verified"]),
            "source": r["source"],
            "installed": bool(r["installed"]) if r["installed"] is not None else None,
            "launchCount": r["launch_count"],
            "lastLaunched": r["last_launched"]
        }

    def delete_app(self, app_id: str) -> bool:
        conn = self.manager.get_connection()
        with conn:
            cursor = conn.execute("DELETE FROM installed_applications WHERE id = ?;", (app_id,))
            return cursor.rowcount > 0


app_repo = AppRepository()
