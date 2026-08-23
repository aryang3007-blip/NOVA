"""
AURA :: Persistence API Dispatcher
==================================
Handles all /api/db/* endpoints for GET, POST, and DELETE.
Zero raw SQL exposed over HTTP. Clean semantic domain operations.
"""

import json
import time
from urllib.parse import urlparse, parse_qs
from typing import Tuple, Dict, Any, Optional

from .db import db_manager
from .vault import credential_vault
from .repositories import (
    config_repo, memory_repo, device_repo,
    wake_repo, app_repo, permission_repo
)
from .importer import import_client_storage


class PersistenceAPIHandler:
    @staticmethod
    def handle_get(path: str, query_params: Dict[str, list]) -> Tuple[Dict[str, Any], int]:
        sub = path[len("/api/db/"):].rstrip("/")
        q = {k: v[0] if v else "" for k, v in query_params.items()}

        if sub == "status":
            return {
                "ok": True,
                "db": {
                    "path": str(db_manager.db_path),
                    "version": db_manager.initialize().get("version", 0),
                    "isLocal": True,
                    "offlineMode": True
                },
                "vault": credential_vault.list_configured_providers()
            }, 200

        if sub == "config":
            return {"ok": True, "config": config_repo.get("aura.config.v1", {})}, 200

        if sub == "memory/conversation":
            session_id = q.get("session") or None
            limit = int(q.get("limit", 160))
            return {"ok": True, "messages": memory_repo.get_messages(session_id=session_id, limit=limit)}, 200

        if sub == "memory/window":
            max_turns = int(q.get("maxTurns", 20))
            return {"ok": True, "messages": memory_repo.get_conversation_window(max_turns=max_turns)}, 200

        if sub == "memory/preferences":
            return {"ok": True, "preferences": memory_repo.get_all_preferences()}, 200

        if sub == "memory/knowledge":
            return {"ok": True, "documents": memory_repo.get_all_knowledge_docs()}, 200

        if sub == "memory/episodes":
            limit = int(q.get("limit", 100))
            return {"ok": True, "episodes": memory_repo.get_episodes(limit=limit)}, 200

        if sub == "memory/identities":
            return {"ok": True, "identities": memory_repo.get_identities()}, 200

        if sub == "permissions":
            return {"ok": True, "permissions": permission_repo.get_all_permissions()}, 200

        if sub == "apps":
            return {"ok": True, "apps": app_repo.get_all_apps()}, 200

        if sub == "devices":
            return {"ok": True, "devices": device_repo.get_all_devices()}, 200

        if sub == "wake":
            return {"ok": True, "phrases": wake_repo.get_all_phrases()}, 200

        if sub == "vault":
            return {"ok": True, "providers": credential_vault.list_configured_providers()}, 200

        if sub == "export":
            data = {
                "config": config_repo.get("aura.config.v1", {}),
                "preferences": memory_repo.get_all_preferences(),
                "knowledge": memory_repo.get_all_knowledge_docs(),
                "permissions": permission_repo.get_all_permissions(),
                "apps": app_repo.get_all_apps(),
                "wake": wake_repo.get_all_phrases(),
                "episodes": memory_repo.get_episodes(200),
                "exportedAt": time.time()
            }
            return {"ok": True, "export": data}, 200

        return {"ok": False, "message": f"Unknown GET route: {path}"}, 404

    @staticmethod
    def handle_post(path: str, payload: Dict[str, Any]) -> Tuple[Dict[str, Any], int]:
        sub = path[len("/api/db/"):].rstrip("/")

        if sub == "config":
            cfg = payload.get("config") if "config" in payload else payload
            # Protect API keys if passed
            keys = cfg.get("apiKeys") if isinstance(cfg, dict) else None
            if isinstance(keys, dict):
                for prov, k in keys.items():
                    if k and isinstance(k, str) and not k.startswith("***"):
                        credential_vault.set_key(prov, k)
                clean_cfg = dict(cfg)
                clean_cfg.pop("apiKeys", None)
                config_repo.set("aura.config.v1", clean_cfg)
            else:
                config_repo.set("aura.config.v1", cfg)
            return {"ok": True, "message": "Config saved."}, 200

        if sub == "memory/conversation":
            res = memory_repo.add_message(
                role=payload.get("role", "user"),
                content=payload.get("content", ""),
                session_id=payload.get("sessionId", "default"),
                pinned=bool(payload.get("pinned", False)),
                msg_id=payload.get("id") or payload.get("msgId")
            )
            return {"ok": True, "message": res}, 200

        if sub == "memory/conversation/pin":
            ok = memory_repo.set_pinned(payload.get("id"), bool(payload.get("pinned", True)))
            return {"ok": ok}, 200 if ok else 404

        if sub == "memory/conversation/edit":
            ok = memory_repo.edit_message(payload.get("id"), payload.get("content", ""))
            return {"ok": ok}, 200 if ok else 404

        if sub == "memory/preferences":
            ok = memory_repo.set_preference(
                key=payload.get("key"),
                value=payload.get("value"),
                source=payload.get("source", "user"),
                confidence=float(payload.get("confidence", 1.0))
            )
            return {"ok": ok}, 200

        if sub == "memory/knowledge":
            res = memory_repo.add_knowledge_doc(
                doc_id=payload.get("id") or f"k_{int(time.time()*1000)}",
                text=payload.get("text", ""),
                title=payload.get("title"),
                source=payload.get("source", "user"),
                tags=payload.get("tags"),
                embedding=payload.get("embedding"),
                embed_model=payload.get("model", "local")
            )
            return {"ok": True, "document": res}, 200

        if sub == "memory/recall":
            query = payload.get("query", "")
            qv = payload.get("queryVector") or payload.get("embedding")
            limit = int(payload.get("limit", 5))
            min_score = float(payload.get("minScore", 0.05))
            results = memory_repo.search_knowledge(query=query, query_vector=qv, limit=limit, min_score=min_score)
            return {"ok": True, "results": results}, 200

        if sub == "memory/episodes":
            res = memory_repo.record_episode(
                event=payload.get("event", ""),
                why=payload.get("why", ""),
                source=payload.get("source", "orchestrator"),
                ep_id=payload.get("id")
            )
            return {"ok": True, "episode": res}, 200

        if sub == "memory/identities":
            res = memory_repo.save_identity(
                name=payload.get("name", "Unknown"),
                signature=payload.get("signature", []),
                ident_id=payload.get("id")
            )
            return {"ok": True, "identity": res}, 200

        if sub == "permissions":
            ok = permission_repo.set_permission(
                perm_id=payload.get("id"),
                granted=bool(payload.get("granted")),
                source=payload.get("source", "user")
            )
            return {"ok": ok}, 200

        if sub == "permissions/revoke-all":
            ok = permission_repo.revoke_all(source=payload.get("source", "user"))
            return {"ok": ok}, 200

        if sub == "apps":
            if "apps" in payload and isinstance(payload["apps"], list):
                for a in payload["apps"]:
                    app_repo.save_app(
                        app_id=a.get("id"),
                        name=a.get("name", a.get("id")),
                        category=a.get("category", "system"),
                        icon=a.get("icon", "📦"),
                        aliases=a.get("aliases"),
                        launchers=a.get("launchers"),
                        executable_path=a.get("executablePath"),
                        web_fallback=a.get("webFallback"),
                        verified=bool(a.get("verified")),
                        source=a.get("source", "user"),
                        installed=a.get("installed", True)
                    )
                return {"ok": True, "count": len(payload["apps"])}, 200
            else:
                res = app_repo.save_app(
                    app_id=payload.get("id"),
                    name=payload.get("name", payload.get("id")),
                    category=payload.get("category", "system"),
                    icon=payload.get("icon", "📦"),
                    aliases=payload.get("aliases"),
                    launchers=payload.get("launchers"),
                    executable_path=payload.get("executablePath"),
                    web_fallback=payload.get("webFallback"),
                    verified=bool(payload.get("verified")),
                    source=payload.get("source", "user"),
                    installed=payload.get("installed", True)
                )
                return {"ok": True, "app": res}, 200

        if sub == "apps/launch":
            ok = app_repo.record_launch(payload.get("id"))
            return {"ok": ok}, 200 if ok else 404

        if sub == "wake":
            res = wake_repo.set_phrase(
                phrase_id=payload.get("id") or payload.get("phrase", "").replace(" ", "_"),
                name=payload.get("name", payload.get("phrase")),
                phrase=payload.get("phrase", ""),
                model=payload.get("model", "hey_jarvis"),
                threshold=float(payload.get("threshold", 0.55)),
                enabled=bool(payload.get("enabled", True))
            )
            return {"ok": True, "phrase": res}, 200

        if sub == "vault":
            prov = payload.get("provider")
            key = payload.get("key")
            if not prov:
                return {"ok": False, "message": "Provider is required."}, 400
            credential_vault.set_key(prov, key)
            return {"ok": True, "message": f"Credential saved securely for {prov}."}, 200

        if sub == "backup":
            dest = payload.get("destination")
            backup_path = db_manager.backup(dest)
            return {"ok": True, "path": str(backup_path)}, 200

        if sub == "migrate/import-client":
            storage = payload.get("storage") or payload
            stats = import_client_storage(storage)
            return {"ok": True, **stats}, 200

        return {"ok": False, "message": f"Unknown POST route: {path}"}, 404

    @staticmethod
    def handle_delete(path: str, query_params: Dict[str, list], payload: Optional[Dict[str, Any]] = None) -> Tuple[Dict[str, Any], int]:
        sub = path[len("/api/db/"):].rstrip("/")
        q = {k: v[0] if v else "" for k, v in query_params.items()}
        p = payload or {}

        if sub == "memory/conversation":
            mid = q.get("id") or p.get("id")
            if mid:
                ok = memory_repo.delete_message(mid)
                return {"ok": ok}, 200 if ok else 404
            session_id = q.get("session") or p.get("session")
            memory_repo.clear_conversation(session_id=session_id)
            return {"ok": True, "message": "Conversation cleared."}, 200

        if sub == "memory/preferences":
            key = q.get("key") or p.get("key")
            if key:
                ok = memory_repo.delete_preference(key)
                return {"ok": ok}, 200 if ok else 404
            memory_repo.clear_preferences()
            return {"ok": True, "message": "Preferences cleared."}, 200

        if sub == "memory/knowledge":
            doc_id = q.get("id") or p.get("id")
            if doc_id:
                ok = memory_repo.delete_knowledge_doc(doc_id)
                return {"ok": ok}, 200 if ok else 404
            memory_repo.clear_knowledge()
            return {"ok": True, "message": "Knowledge base cleared."}, 200

        if sub == "memory/episodes":
            memory_repo.clear_episodes()
            return {"ok": True, "message": "Episodes cleared."}, 200

        if sub == "memory/identities":
            ident_id = q.get("id") or p.get("id")
            if ident_id:
                ok = memory_repo.delete_identity(ident_id)
                return {"ok": ok}, 200 if ok else 404
            return {"ok": False, "message": "Identity id required."}, 400

        if sub == "apps":
            app_id = q.get("id") or p.get("id")
            if app_id:
                ok = app_repo.delete_app(app_id)
                return {"ok": ok}, 200 if ok else 404
            return {"ok": False, "message": "App id required."}, 400

        if sub == "wake":
            phrase_id = q.get("id") or p.get("id")
            if phrase_id:
                ok = wake_repo.delete_phrase(phrase_id)
                return {"ok": ok}, 200 if ok else 404
            return {"ok": False, "message": "Phrase id required."}, 400

        if sub == "vault":
            prov = q.get("provider") or p.get("provider")
            if prov:
                credential_vault.delete_key(prov)
                return {"ok": True, "message": f"Credential deleted for {prov}."}, 200
            return {"ok": False, "message": "Provider is required."}, 400

        return {"ok": False, "message": f"Unknown DELETE route: {path}"}, 404
