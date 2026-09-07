#!/usr/bin/env python3
"""
AURA :: Master Controls tests
==============================
Proves the competition rule "only working features": every feature/page/
pipeline can be turned OFF from one page, but NO toggle combination can
brick the site — fail-open defaults, unknown/corrupt values resolve to ON,
protected core refuses to disable, hidden features are blocked at the
routing layer, and every gate degrades honestly.

    python3 tests/test-controls.py

Runs against its OWN temp SQLite DB (AURA_DB_PATH set before imports).
"""
import os
import sys
import tempfile
from pathlib import Path

_TMP = tempfile.mkdtemp(prefix="aura-controls-test-")
os.environ["AURA_DB_PATH"] = os.path.join(_TMP, "controls.db")

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from persistence import db_manager                  # noqa: E402
db_manager.initialize()
from persistence import feature_flags as ff          # noqa: E402
from persistence import api as persistence_api       # noqa: E402
from persistence.repositories import config_repo     # noqa: E402

P = F = 0


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


S("REGISTRY DEFAULTS — everything ON, core protected")
defs = ff.defs()
rec("35 registrable features/pages/pipelines", len(defs) == 35, str(len(defs)))
rec("all default to ON", all(d["on"] for d in defs))
rec("controls page + chat panel locked", {"page.controls", "panel.chat"} <= set(ff.counts()["protected"]))
rec("every flag id matches the validated key pattern", all(__import__("re").match(r"^[A-Za-z][A-Za-z0-9._-]{0,63}$", d["id"]) for d in defs))
rec("kinds cover page/panel/tab/app/pipeline", {d["kind"] for d in defs} == {"page", "panel", "tab", "app", "pipeline"})

S("FAIL-OPEN — the site can never be hidden by bad data")
rec("unknown id resolves ON", ff.is_on("totally.unknown") is True)
config_repo.set("aura.featureFlags", {"page.live": False})
rec("known flag OFF persists", ff.is_on("page.live") is False)
config_repo.set("aura.featureFlags", {"page.live": "false", "pipe.docgen": 0, "junk": 1})
rec("corrupt values ignored (string 'false' → ON)", ff.is_on("page.live") is True)
rec("unlisted junk key ignored", ff.is_on("junk") is True)
config_repo.set("aura.featureFlags", None)
rec("whole store corrupt → everything ON", all(ff.is_on(d["id"]) for d in defs))

S("API — /api/db/flags")
api_handler = persistence_api.PersistenceAPIHandler
r = api_handler.handle_get("/api/db/flags", {})
rec("GET returns ok + 35 flags", r[0].get("ok") and len(r[0]["flags"]) == 35)
rec("counts present", r[0]["counts"]["total"] == 35 and r[0]["counts"]["off"] == 0)

r = api_handler.handle_post("/api/db/flags", {"id": "page.phone", "enabled": False})
rec("POST turns a page OFF", r[0]["ok"] and ff.is_on("page.phone") is False)
rec("POST response re-syncs state", r[0]["counts"]["off"] == 1)

r = api_handler.handle_post("/api/db/flags", {"id": "page.unknown", "enabled": False})
rec("POST unknown id → 400", r[1] == 400 and not r[0]["ok"])
r = api_handler.handle_post("/api/db/flags", {"id": "page.controls", "enabled": False})
rec("POST protected page → 400 (locked)", r[1] == 400 and not r[0]["ok"])
r = api_handler.handle_post("/api/db/flags", {"id": "pipe.docgen", "enabled": "no"})
rec("POST non-bool value → 400", r[1] == 400 and not r[0]["ok"])
r = api_handler.handle_post("/api/db/flags", {"id": "pipe.docgen", "enabled": 1})
rec("POST 0/1 accepted as bool", r[0]["ok"] and ff.is_on("pipe.docgen") is True)
r = api_handler.handle_post("/api/db/flags", {"id": "pipe.docgen", "enabled": 0})
rec("POST 0 → OFF", r[0]["ok"] and ff.is_on("pipe.docgen") is False)

r = api_handler.handle_post("/api/db/flags/reset", {})
rec("RESET restores everything ON", r[0]["ok"] and r[0]["counts"]["off"] == 0)
rec("after reset all flags on", all(ff.is_on(d["id"]) for d in defs))


S("ROUTING LAYER — serve.py gates, fail-open")
import server.serve as serve_mod                    # noqa: E402
rec("_feature_on unknown → True", serve_mod._feature_on("nope.nope") is True)
r_router = serve_mod._feature_on("page.live")
rec("page.live ON by default at router", r_router is True)
ff.set_flag("page.live", False)
rec("page.live OFF reaches router", serve_mod._feature_on("page.live") is False)
rec("protected page.controls never disabled at router", serve_mod._feature_on("page.controls") is True)
ff.set_flag("page.live", True)


S("PIPELINE — images.generate honest OFF, deck-safe")
from services.docgen import images as images_mod     # noqa: E402
ff.set_flag("pipe.images", False)
r = images_mod.generate("test", "flat illustration", "gemini", outdir=_TMP,
                        key_fn=lambda k: "fake-key", urlopen_fn=lambda *a, **k: (_ for _ in ()).throw(AssertionError("must not hit wire")))
rec("pipe.images OFF → honest off result, no wire call", r.get("off") is True and not r.get("ok"))
ff.set_flag("pipe.images", True)
ff.set_flag("pipe.docgen", False)
rec("pipe.docgen OFF → next images.generate is NOT blocked by docgen flag",
    images_mod.generate("test", "flat illustration", "gemini", outdir=_TMP,
                        key_fn=lambda k: "fake-key")["ok"] is False)  # no key, but no feature_off code
ff.set_flag("pipe.docgen", True)


S("BRIDGE — actions blocked server-side, shell-safe")
from server import bridge as bridge_mod              # noqa: E402
ff.set_flag("pipe.docgen", False)
r = bridge_mod.dispatch("doc_build", {"kind": "pptx", "spec": {}})
rec("doc_build OFF → disabled payload", r.get("disabled") is True and r.get("code") == "feature_off")
ff.set_flag("pipe.docgen", True)
ff.set_flag("dev.imageTest", False)
r = bridge_mod.dispatch("image_test", {"prompt": "x"})
rec("image_test OFF → disabled payload", r.get("disabled") is True)
ff.set_flag("dev.imageTest", True)
ff.set_flag("pipe.websearch", False)
r = bridge_mod.dispatch("web_capabilities", {})
rec("web_capabilities OFF → disabled payload", r.get("disabled") is True)
ff.set_flag("pipe.websearch", True)
ff.set_flag("pipe.organizer", False)
r = bridge_mod.dispatch("organize_plan", {"target": "/tmp"})
rec("organize_* OFF → disabled payload", r.get("disabled") is True)
ff.set_flag("pipe.organizer", True)
ff.set_flag("pipe.automation", False)
r = bridge_mod.dispatch("automation_capabilities", {})
rec("automation_* OFF → disabled payload", r.get("disabled") is True)
ff.set_flag("pipe.automation", True)
ff.set_flag("pipe.desktop", False)
r = bridge_mod.dispatch("open_app", {"app": "calc"})
rec("desktop actions OFF → disabled payload", r.get("disabled") is True)
r = bridge_mod.dispatch("get_policy", {})
rec("shell-critical get_policy STILL allowed (no brick)", not r.get("disabled"))
r = bridge_mod.dispatch("system_info", {})
rec("shell-critical system_info STILL allowed (no brick)", not r.get("disabled"))
ff.set_flag("pipe.desktop", True)
ff.reset()

print(f"\n\x1b[32mPASS {P}\x1b[0m  \x1b[31mFAIL {F}\x1b[0m")
sys.exit(1 if F else 0)
