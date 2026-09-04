"""
AURA :: Usage / spend repository
================================
The quota ledger behind the "Keys & Spend" panel. Every keyed API call —
chat, document outline, AI image — is recorded here (provider, model, kind,
status). The budget is a simple daily cap, stored in the settings table as
JSON: enabled, requestsPerDay (0 = unlimited), imagesPerDay (0 = unlimited).
No secrets, no tokens, no prompt content — only counts.
"""

import json
import time
from typing import Any, Dict, List, Optional, Tuple

from ..db import db_manager

_BUDGET_KEY = "usage.budget"

DEFAULT_BUDGET = {
    "enabled": True,
    "requestsPerDay": 60,   # 0 = unlimited
    "imagesPerDay": 5,      # 0 = unlimited — images cost the most
    "imageIntervalSec": 5,  # min seconds between image calls on one key
                            # (RPM guard — 0 = off)
}


class UsageRepository:
    def __init__(self, manager=None):
        self.manager = manager or db_manager

    # ── ledger ─────────────────────────────────────────────────────────
    def record(self, provider: str, model: str = "", kind: str = "chat",
               status: str = "ok", detail: str = "") -> bool:
        conn = self.manager.get_connection()
        with conn:
            conn.execute(
                "INSERT INTO usage_log (ts, provider, model, kind, status, detail) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (time.time(), str(provider or "?"), str(model or "")[:80],
                 str(kind or "chat")[:20], str(status or "ok")[:20],
                 str(detail or "")[:300]),
            )
        return True

    def recent(self, limit: int = 25) -> List[Dict[str, Any]]:
        conn = self.manager.get_connection()
        cursor = conn.execute(
            "SELECT id, ts, provider, model, kind, status, detail "
            "FROM usage_log ORDER BY ts DESC LIMIT ?",
            (max(1, min(200, int(limit))),))
        return [dict(r) for r in cursor.fetchall()]

    def clear(self) -> int:
        conn = self.manager.get_connection()
        with conn:
            cursor = conn.execute("DELETE FROM usage_log")
            return cursor.rowcount

    def _counts_since(self, since_ts: float) -> Dict[str, Any]:
        conn = self.manager.get_connection()
        cursor = conn.execute(
            "SELECT provider, kind, status, COUNT(*) AS n FROM usage_log "
            "WHERE ts >= ? GROUP BY provider, kind, status", (since_ts,))
        by = {}
        providers, images, errors = {}, 0, 0
        total = 0
        for row in cursor.fetchall():
            total += row["n"]
            providers.setdefault(row["provider"], {"requests": 0, "images": 0,
                                                   "errors": 0})
            if row["kind"] == "image":
                images += row["n"]
                providers[row["provider"]]["images"] += row["n"]
            else:
                providers[row["provider"]]["requests"] += row["n"]
            if row["status"] in ("error", "blocked"):
                errors += row["n"]
                providers[row["provider"]]["errors"] += row["n"]
        by = {"total": total, "images": images, "errors": errors,
              "providers": providers}
        return by

    def summary(self, limit: int = 25) -> Dict[str, Any]:
        day_start = time.mktime(time.localtime()[:3] + (0, 0, 0, 0, 0, -1))
        today = self._counts_since(day_start)
        conn = self.manager.get_connection()
        cursor = conn.execute("SELECT COUNT(*), MIN(ts) FROM usage_log")
        row = cursor.fetchone()
        return {
            "today": today,
            "total": {"count": row[0] or 0, "since": row[1] or None},
            "recent": self.recent(limit),
            "budget": self.get_budget(),
        }

    # ── budget ─────────────────────────────────────────────────────────
    def get_budget(self) -> Dict[str, Any]:
        conn = self.manager.get_connection()
        cursor = conn.execute(
            "SELECT value FROM settings WHERE key = ?", (_BUDGET_KEY,))
        row = cursor.fetchone()
        if not row:
            return dict(DEFAULT_BUDGET)
        try:
            b = json.loads(row["value"])
            if isinstance(b, dict):
                return {**DEFAULT_BUDGET, **b}
        except Exception:
            pass
        return dict(DEFAULT_BUDGET)

    def set_budget(self, budget: Dict[str, Any]) -> Dict[str, Any]:
        clean = {
            "enabled": bool(budget.get("enabled", DEFAULT_BUDGET["enabled"])),
            "requestsPerDay": max(0, int(budget.get("requestsPerDay", 60))),
            "imagesPerDay": max(0, int(budget.get("imagesPerDay", 5))),
            "imageIntervalSec": max(0, int(budget.get("imageIntervalSec", 5))),
        }
        conn = self.manager.get_connection()
        with conn:
            conn.execute(
                "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value, "
                "updated_at = excluded.updated_at",
                (_BUDGET_KEY, json.dumps(clean), time.time()))
        return clean

    # ── enforcement ────────────────────────────────────────────────────
    def check(self, kind: str = "chat") -> Tuple[bool, Dict[str, Any]]:
        """
        (allowed, info). kind is 'image' or anything else (a request).
        A cap of 0 means unlimited. Blocked BEFORE the network call so a
        quota error never costs a single request.
        """
        budget = self.get_budget()
        if not budget.get("enabled", True):
            return True, {"budget": budget}
        cap = budget.get("imagesPerDay" if kind == "image" else "requestsPerDay", 0)
        used = self.summary()["today"]["images" if kind == "image" else "total"]
        allowed = cap <= 0 or used < cap
        return allowed, {"budget": budget, "used": used, "cap": cap,
                         "kind": kind, "allowed": allowed}


usage_repo = UsageRepository()
