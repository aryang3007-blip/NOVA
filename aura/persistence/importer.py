"""
AURA :: Legacy Persistence Importer
===================================
Non-destructive, idempotent migration tool that imports legacy localStorage
payloads and JSON configuration files into the authoritative SQLite database.
"""

import json
import time
from pathlib import Path
from typing import Any, Dict, Optional

from .db import db_manager
from .vault import credential_vault
from .repositories import (
    config_repo, memory_repo, device_repo,
    wake_repo, app_repo, permission_repo
)

ROOT_DIR = Path(__file__).resolve().parent.parent


def seed_wake_phrases_from_file(file_path: Optional[Path] = None) -> int:
    """Import wake phrases from legacy wake_phrases.json if database is empty."""
    p = file_path or (ROOT_DIR / "voice" / "wake_phrases.json")
    if not p.exists():
        return 0

    existing = wake_repo.get_all_phrases()
    if len(existing) > 0:
        return 0

    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        phrases = data.get("phrases", [])
        count = 0
        for item in phrases:
            name = item.get("name") or "Hey Nova"
            phrase = item.get("phrase") or name.lower()
            model = item.get("model") or "hey_jarvis"
            enabled = bool(item.get("enabled", True))
            pid = phrase.replace(" ", "_")
            wake_repo.set_phrase(pid, name, phrase, model=model, enabled=enabled)
            count += 1
        print(f"[MIGRATION] Seeded {count} wake phrases into SQLite from {p.name}", flush=True)
        return count
    except Exception as e:
        print(f"[MIGRATION] Error seeding wake phrases: {e}", flush=True)
        return 0


def import_client_storage(payload: Dict[str, Any]) -> Dict[str, Any]:
    """
    Import browser localStorage keys into SQLite.
    Idempotent: running twice will update records without corrupting or duplicating.
    """
    stats = {
        "configImported": False,
        "apiKeysSecured": 0,
        "permissionsImported": 0,
        "appsImported": 0,
        "messagesImported": 0,
        "preferencesImported": 0,
        "knowledgeImported": 0,
        "episodesImported": 0,
        "facesImported": 0
    }

    # 1. Config & API Keys
    cfg = payload.get("config") or payload.get("aura.config.v1")
    if isinstance(cfg, dict):
        # Extract and protect API keys in DPAPI Vault
        keys = cfg.get("apiKeys") or {}
        if isinstance(keys, dict):
            for prov, k in keys.items():
                if k and isinstance(k, str) and not k.startswith("***"):
                    credential_vault.set_key(prov, k)
                    stats["apiKeysSecured"] += 1

        # Strip keys before storing in settings
        clean_cfg = dict(cfg)
        clean_cfg.pop("apiKeys", None)
        config_repo.set("aura.config.v1", clean_cfg)
        stats["configImported"] = True

    # 2. Permissions
    perms = payload.get("permissions") or payload.get("aura.permissions.v1")
    if isinstance(perms, dict):
        for pid, grant in perms.items():
            if isinstance(grant, dict):
                permission_repo.set_permission(pid, bool(grant.get("granted")), grant.get("source", "user"))
            elif isinstance(grant, bool):
                permission_repo.set_permission(pid, grant, "user")
            stats["permissionsImported"] += 1

    # 3. Application Database
    appdb = payload.get("apps") or payload.get("aura.appdb.v1")
    if isinstance(appdb, dict):
        apps_list = appdb.get("apps") or []
        for a in apps_list:
            if isinstance(a, dict) and a.get("id"):
                app_repo.save_app(
                    app_id=a["id"],
                    name=a.get("name", a["id"]),
                    category=a.get("category", "system"),
                    icon=a.get("icon", "📦"),
                    aliases=a.get("aliases"),
                    launchers=a.get("launchers"),
                    executable_path=a.get("executablePath"),
                    web_fallback=a.get("webFallback"),
                    verified=bool(a.get("verified")),
                    source=a.get("source", "mock"),
                    installed=a.get("installed", True)
                )
                stats["appsImported"] += 1

    # 4. Conversation Messages
    conv = payload.get("conversation") or payload.get("aura.mem.conv.messages") or payload.get("aura.memory.v1")
    if isinstance(conv, list):
        for m in conv:
            if isinstance(m, dict) and m.get("role") and m.get("content"):
                mid = f"{m.get('t', int(time.time()*1000))}-{m['role']}"
                memory_repo.add_message(
                    role=m["role"],
                    content=m["content"],
                    pinned=bool(m.get("pinned")),
                    msg_id=mid
                )
                stats["messagesImported"] += 1
    elif isinstance(conv, dict) and isinstance(conv.get("messages"), list):
        for m in conv["messages"]:
            if isinstance(m, dict) and m.get("role") and m.get("content"):
                mid = f"{m.get('t', int(time.time()*1000))}-{m['role']}"
                memory_repo.add_message(
                    role=m["role"],
                    content=m["content"],
                    pinned=bool(m.get("pinned")),
                    msg_id=mid
                )
                stats["messagesImported"] += 1

    # 5. User Preferences
    prefs = payload.get("preferences") or payload.get("aura.mem.pref.prefs")
    if isinstance(prefs, dict):
        for k, v in prefs.items():
            if isinstance(v, dict) and "value" in v:
                memory_repo.set_preference(k, v["value"], v.get("source", "user"), float(v.get("confidence", 1.0)))
            else:
                memory_repo.set_preference(k, v, "user", 1.0)
            stats["preferencesImported"] += 1

    # 6. Knowledge Documents
    know = payload.get("knowledge") or payload.get("aura.mem.know.documents")
    if isinstance(know, list):
        for doc in know:
            if isinstance(doc, dict) and doc.get("id") and doc.get("text"):
                memory_repo.add_knowledge_doc(
                    doc_id=doc["id"],
                    text=doc["text"],
                    title=doc.get("title") or (doc.get("metadata") or {}).get("title"),
                    source=doc.get("source") or (doc.get("metadata") or {}).get("source", "user"),
                    tags=doc.get("tags") or (doc.get("metadata") or {}).get("tags", [])
                )
                stats["knowledgeImported"] += 1

    # 7. Episodic Memories
    episodes = payload.get("episodes") or payload.get("nova.mem.episodes")
    if isinstance(episodes, list):
        for ep in episodes:
            if isinstance(ep, dict) and ep.get("event"):
                memory_repo.record_episode(
                    event=ep["event"],
                    why=ep.get("why", ""),
                    source=ep.get("source", "orchestrator"),
                    ep_id=ep.get("id")
                )
                stats["episodesImported"] += 1

    # 8. Face Signatures
    faces = payload.get("faces") or payload.get("aura.faces.v1")
    if isinstance(faces, dict) and isinstance(faces.get("people"), list):
        for person in faces["people"]:
            if isinstance(person, dict) and person.get("name") and person.get("signature"):
                memory_repo.save_identity(person["name"], person["signature"])
                stats["facesImported"] += 1

    print(f"[MIGRATION] Client storage import completed: {stats}", flush=True)
    return {"ok": True, "stats": stats}
