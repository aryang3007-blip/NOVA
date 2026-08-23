"""
AURA :: Device Repository
=========================
Manages durable paired companion devices.
Separates persistent pairing identities and capabilities from volatile connection heartbeats.
"""

import json
import time
from typing import Any, Dict, List, Optional
from ..db import db_manager


class DeviceRepository:
    def __init__(self, manager=None):
        self.manager = manager or db_manager

    def save_device(self, device_id: str, name: str, platform: str, kind: str,
                    token: str, capabilities: List[str], paired_at: Optional[float] = None) -> Dict[str, Any]:
        conn = self.manager.get_connection()
        now = time.time()
        p_at = paired_at or now
        caps_json = json.dumps(capabilities)

        with conn:
            conn.execute(
                """
                INSERT INTO devices (id, name, platform, kind, token, capabilities, paired_at, last_seen, is_active, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    platform = excluded.platform,
                    kind = excluded.kind,
                    token = excluded.token,
                    capabilities = excluded.capabilities,
                    last_seen = excluded.last_seen,
                    is_active = 1,
                    updated_at = excluded.updated_at;
                """,
                (device_id, name, platform, kind, token, caps_json, p_at, now, now, now)
            )
        return {
            "id": device_id, "name": name, "platform": platform, "kind": kind,
            "token": token, "capabilities": capabilities, "pairedAt": p_at, "lastSeen": now
        }

    def get_device(self, device_id: str) -> Optional[Dict[str, Any]]:
        conn = self.manager.get_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT id, name, platform, kind, token, capabilities, paired_at, last_seen, battery, latency_ms FROM devices WHERE id = ? AND is_active = 1;", (device_id,))
        r = cursor.fetchone()
        if not r:
            return None
        return {
            "id": r["id"],
            "name": r["name"],
            "platform": r["platform"],
            "kind": r["kind"],
            "token": r["token"],
            "capabilities": json.loads(r["capabilities"]),
            "pairedAt": r["paired_at"],
            "lastSeen": r["last_seen"],
            "battery": r["battery"],
            "latencyMs": r["latency_ms"]
        }

    def get_all_devices(self) -> List[Dict[str, Any]]:
        conn = self.manager.get_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT id, name, platform, kind, token, capabilities, paired_at, last_seen, battery, latency_ms FROM devices WHERE is_active = 1;")
        out = []
        for r in cursor.fetchall():
            out.append({
                "id": r["id"],
                "name": r["name"],
                "platform": r["platform"],
                "kind": r["kind"],
                "token": r["token"],
                "capabilities": json.loads(r["capabilities"]),
                "pairedAt": r["paired_at"],
                "lastSeen": r["last_seen"],
                "battery": r["battery"],
                "latencyMs": r["latency_ms"]
            })
        return out

    def update_heartbeat(self, device_id: str, battery: Optional[float] = None, latency_ms: Optional[float] = None, caps: Optional[List[str]] = None) -> bool:
        conn = self.manager.get_connection()
        now = time.time()
        with conn:
            if caps is not None:
                conn.execute(
                    "UPDATE devices SET last_seen = ?, battery = coalesce(?, battery), latency_ms = coalesce(?, latency_ms), capabilities = ? WHERE id = ?;",
                    (now, battery, latency_ms, json.dumps(caps), device_id)
                )
            else:
                conn.execute(
                    "UPDATE devices SET last_seen = ?, battery = coalesce(?, battery), latency_ms = coalesce(?, latency_ms) WHERE id = ?;",
                    (now, battery, latency_ms, device_id)
                )
        return True

    def unpair_device(self, device_id: str) -> bool:
        conn = self.manager.get_connection()
        with conn:
            cursor = conn.execute("UPDATE devices SET is_active = 0 WHERE id = ?;", (device_id,))
            return cursor.rowcount > 0

    def delete_device_hard(self, device_id: str) -> bool:
        conn = self.manager.get_connection()
        with conn:
            cursor = conn.execute("DELETE FROM devices WHERE id = ?;", (device_id,))
            return cursor.rowcount > 0


device_repo = DeviceRepository()
