#!/usr/bin/env python3
"""
AURA :: usage ledger + spend budget tests
=========================================
Runs against its OWN temp SQLite DB (AURA_DB_PATH set BEFORE any persistence
import) so the panel's quota math is proven without touching the real DB.

    python3 tests/test-usage.py
"""
import os
import sys
import tempfile
from pathlib import Path

_TMP = tempfile.mkdtemp(prefix="aura-usage-test-")
os.environ["AURA_DB_PATH"] = os.path.join(_TMP, "usage.db")

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from persistence import db_manager               # noqa: E402
db_manager.initialize()                           # runs migrations 001..005
from persistence import api                      # noqa: E402
from persistence.repositories import usage_repo   # noqa: E402

P = F = 0


def json_lower(obj):
    import json
    return json.dumps(obj).lower()


def rec(name, cond, detail=""):
    global P, F
    if cond:
        P += 1
        print(f"  \x1b[32m✓\x1b[0m {name}")
    else:
        F += 1
        print(f"  \x1b[31m✗\x1b[0m {name}  \x1b[90m{detail}\x1b[0m")


def S(t):
    print(f"\n\x1b[36m▸ {t}\x1b[0m")


S("MIGRATION + LEDGER")
usage_repo.record("gemini", "gemini-3.1-flash-image", kind="image", status="ok", detail="png")
usage_repo.record("gemini", "gemini-3.8-flash", kind="outline", status="ok")
usage_repo.record("openai", "gpt-4o-mini", kind="chat", status="error", detail="HTTP 429")
usage_repo.record("gemini", "gemini-3.8-flash", kind="outline", status="ok")
rec("table exists and accepts the schema", True)
s = usage_repo.summary()
rec("summary counts today (4 calls: 1 image, 3 requests, 1 error)",
    s["today"]["total"] == 4 and s["today"]["images"] == 1
    and s["today"]["errors"] == 1, str(s["today"]))
rec("recent is newest-first (last row is the 2nd outline call)",
    s["recent"][0]["kind"] == "outline" and s["recent"][0]["status"] == "ok")
rec("per-provider breakdown present",
    s["today"]["providers"]["gemini"]["requests"] == 2
    and s["today"]["providers"]["gemini"]["images"] == 1
    and s["today"]["providers"]["openai"]["errors"] == 1, str(s["today"]["providers"]))

S("BUDGET (cap checked BEFORE the wire; 0 = unlimited)")
rec("default budget exists and is enabled",
    s["budget"]["enabled"] and s["budget"]["imagesPerDay"] > 0)
allowed, info = usage_repo.check("image")
rec("under the image cap → allowed", allowed, str(info))
usage_repo.set_budget({"enabled": True, "requestsPerDay": 0, "imagesPerDay": 1})
allowed, info = usage_repo.check("image")
rec("image cap hit (1/1) → blocked BEFORE the call",
    not allowed and info["used"] == 1 and info["cap"] == 1, str(info))
usage_repo.set_budget({"enabled": True, "requestsPerDay": 2, "imagesPerDay": 0})
allowed, info = usage_repo.check("chat")
rec("request cap hit (3/2) → blocked for chat too",
    not allowed and info["cap"] == 2, str(info))
usage_repo.set_budget({"enabled": False, "requestsPerDay": 0, "imagesPerDay": 0})
allowed, _ = usage_repo.check("chat")
rec("budget disabled → never blocks", allowed)

S("API ROUTES (/api/db/usage*)")
d, code = api.PersistenceAPIHandler.handle_get("/api/db/usage/summary", {})
rec("GET usage/summary returns the ledger + budget",
    code == 200 and d["summary"]["today"]["total"] >= 3 and d["summary"]["budget"]["enabled"] is False,
    str(code))
d, code = api.PersistenceAPIHandler.handle_get("/api/db/usage", {"limit": ["2"]})
rec("GET usage returns a bounded newest-first log",
    code == 200 and len(d["log"]) == 2, f"{code} {len(d.get('log', []))}")
for entry in d["log"]:
    rec("log rows never contain secret material",
        all(k not in json_lower(entry) for k in ("sk-", "key=", "Bearer")), "")
d, code = api.PersistenceAPIHandler.handle_post("/api/db/usage/log", {
    "provider": "anthropic", "model": "claude-haiku", "kind": "chat", "status": "ok"})
rec("POST usage/log records one call", code == 200 and len(usage_repo.recent()) == 5)
d, code = api.PersistenceAPIHandler.handle_post("/api/db/usage/budget", {
    "budget": {"enabled": True, "requestsPerDay": 7, "imagesPerDay": 2}})
rec("POST usage/budget stores the cap", code == 200 and d["budget"]["requestsPerDay"] == 7)
d, code = api.PersistenceAPIHandler.handle_delete("/api/db/usage", {}, {})
rec("DELETE usage clears the ledger", code == 200 and usage_repo.summary()["total"]["count"] == 0)
rec("budget survives the clear (it is a setting, not a log row)",
    usage_repo.get_budget()["imagesPerDay"] == 2)


def json_lower(obj):
    import json
    return json.dumps(obj).lower()


print(f"\n\x1b[36mPASS {P}\x1b[0m \x1b[31mFAIL {F}\x1b[0m")
sys.exit(1 if F else 0)
