"""
AURA :: Feature Flags (Master Controls)
========================================
One registry of every switchable feature/page/pipeline for the competition
"Master Controls" page (/controls). Design rules that make it IMPOSSIBLE to
brick the site:

  1. DEFAULT = EVERYTHING ON. Shipping state is untouched unless the owner
     flips a toggle.
  2. FAIL-OPEN for availability: unknown flag ids, missing rows, corrupt
     JSON and invalid stored values all resolve to ON. A broken settings
     row can never hide the app.
  3. PROTECTED core: the controls page itself and the root app cannot be
     turned off (the API refuses, the page is never gated) — so the owner
     can always get back in and press "RESET ALL".
  4. Validation: flag ids must be known; stored values must be booleans;
     junk is ignored, never stored.
  5. One key in the DB (`aura.featureFlags`), one source of truth, read by
     the server, the bridge, the terminal and the browser.

    from persistence.feature_flags import FLAGS, is_on, set_flag, reset, defs
"""

import json
import os
import re
import time

from .repositories import config_repo

_STORE_KEY = "aura.featureFlags"
_KEY_RE = re.compile(r"^[A-Za-z][A-Za-z0-9._-]{0,63}$")

# ── the registry ────────────────────────────────────────────────────────────
# kind: "page" (route/dock), "tab" (settings tab), "app" (feature popup),
#       "pipeline" (backend behaviour).
FLAG_DEFS = [
    # ── PAGES ────────────────────────────────────────────────────────────
    {"id": "page.live", "kind": "page", "default": True, "protected": False,
     "label": "AURA Live screen page (/screen)",
     "desc": "Full-screen control dashboard. Off = the page and its dock entry disappear."},
    {"id": "page.phone", "kind": "page", "default": True, "protected": False,
     "label": "Phone / companion page (/phone)",
     "desc": "Android companion pairing page."},
    {"id": "page.dev", "kind": "page", "default": True, "protected": False,
     "label": "Developer page (/dev)",
     "desc": "Version + release notes page."},
    {"id": "page.db", "kind": "page", "default": True, "protected": False,
     "label": "Database manager (/db)",
     "desc": "Settings, budget, usage, backup/restore management page."},
    {"id": "dev.imageTest", "kind": "page", "default": True, "protected": False,
     "label": "Image production test UI (/dev/image-test.html)",
     "desc": "Temporary dev harness for testing image generation separately."},
    {"id": "page.controls", "kind": "page", "default": True, "protected": True,
     "label": "Master Controls page (/controls)",
     "desc": "This page. LOCKED — you always need a way back in."},

    # ── DOCK PANELS ──────────────────────────────────────────────────────
    {"id": "panel.chat", "kind": "panel", "default": True, "protected": True,
     "label": "Chat panel",
     "desc": "The conversation surface. LOCKED — hiding it would leave the "
             "assistant unusable, and the controls page must never brick."},
    {"id": "panel.vision", "kind": "panel", "default": True, "protected": False,
     "label": "Vision panel",
     "desc": "Camera vision, gesture and face detection panel."},
    {"id": "panel.dev", "kind": "panel", "default": True, "protected": False,
     "label": "Developer console",
     "desc": "The 'how AURA thinks' console panel."},
    {"id": "panel.system", "kind": "panel", "default": True, "protected": False,
     "label": "System center",
     "desc": "Telemetry, memory and diagnostics panel."},
    {"id": "panel.style", "kind": "panel", "default": True, "protected": False,
     "label": "Avatar wardrobe",
     "desc": "Avatar style and wardrobe panel."},
    {"id": "panel.mic", "kind": "panel", "default": True, "protected": False,
     "label": "Microphone toggle",
     "desc": "The dock microphone button (voice input entry)."},
    {"id": "panel.voice", "kind": "panel", "default": True, "protected": False,
     "label": "Voice output toggle",
     "desc": "The dock speak button (voice output entry)."},
    {"id": "panel.wake", "kind": "panel", "default": True, "protected": False,
     "label": "Wake word toggle",
     "desc": "The dock wake button (continuous wake-word detection entry)."},

    # ── SETTINGS TABS ────────────────────────────────────────────────────
    {"id": "ui.ai", "kind": "tab", "default": True, "protected": False,
     "label": "Settings tab · AI CORE",
     "desc": "AI provider, model, tokens and temperature settings."},
    {"id": "ui.voice", "kind": "tab", "default": True, "protected": False,
     "label": "Settings tab · VOICE",
     "desc": "Voice input/output settings."},
    {"id": "ui.vision", "kind": "tab", "default": True, "protected": False,
     "label": "Settings tab · VISION",
     "desc": "Face, hand and object vision settings."},
    {"id": "ui.interface", "kind": "tab", "default": True, "protected": False,
     "label": "Settings tab · INTERFACE",
     "desc": "UI behaviour settings."},
    {"id": "ui.connect", "kind": "tab", "default": True, "protected": False,
     "label": "Settings tab · CONNECT",
     "desc": "Web research, automations and connection settings."},
    {"id": "ui.devices", "kind": "tab", "default": True, "protected": False,
     "label": "Settings tab · DEVICES",
     "desc": "Paired device management."},
    {"id": "ui.appearance", "kind": "tab", "default": True, "protected": False,
     "label": "Settings tab · APPEARANCE",
     "desc": "Themes, previews and visual options."},
    {"id": "ui.memory", "kind": "tab", "default": True, "protected": False,
     "label": "Settings tab · MEMORY",
     "desc": "Conversation history, pinned facts, knowledge base."},
    {"id": "ui.avatar", "kind": "tab", "default": True, "protected": False,
     "label": "Settings tab · AVATAR",
     "desc": "Avatar manager and wardrobe."},
    {"id": "ui.desktop", "kind": "tab", "default": True, "protected": False,
     "label": "Settings tab · DESKTOP",
     "desc": "Desktop actions, automation and research settings."},
    {"id": "ui.keys", "kind": "tab", "default": True, "protected": False,
     "label": "Settings tab · KEYS & SPEND",
     "desc": "API keys, spend budget and usage ledger."},
    {"id": "ui.about", "kind": "tab", "default": True, "protected": False,
     "label": "Settings tab · ABOUT",
     "desc": "About NOVA."},

    # ── FEATURE APPS (intent popups) ─────────────────────────────────────
    {"id": "apps.pptx", "kind": "app", "default": True, "protected": False,
     "label": "PPT Builder (presentations)",
     "desc": "\"make a ppt…\" — outline, visuals, motion, deck file."},
    {"id": "apps.docx", "kind": "app", "default": True, "protected": False,
     "label": "Word Report Builder",
     "desc": "\"write a report…\" — .docx reports."},
    {"id": "apps.xlsx", "kind": "app", "default": True, "protected": False,
     "label": "Spreadsheet Builder",
     "desc": "\"make a spreadsheet…\" — .xlsx workbooks."},
    {"id": "apps.research", "kind": "app", "default": True, "protected": False,
     "label": "Web Research",
     "desc": "\"research…\" — live web research feature."},

    # ── PIPELINES (backend behaviour) ────────────────────────────────────
    {"id": "pipe.docgen", "kind": "pipeline", "default": True, "protected": False,
     "label": "Document generation pipeline",
     "desc": "PPT/Word/Excel build actions (terminal /doc + app docBuild)."},
    {"id": "pipe.images", "kind": "pipeline", "default": True, "protected": False,
     "label": "AI image generation pipeline",
     "desc": "Image-only key calls, direct image test, AI images in decks. "
             "Off = decks are built without AI images (search-first visuals still work)."},
    {"id": "pipe.websearch", "kind": "pipeline", "default": True, "protected": False,
     "label": "Web search / research pipeline",
     "desc": "web_search, web_research, read_page bridge actions."},
    {"id": "pipe.organizer", "kind": "pipeline", "default": True, "protected": False,
     "label": "File organizer pipeline",
     "desc": "organize_* actions (preview → apply → undo)."},
    {"id": "pipe.automation", "kind": "pipeline", "default": True, "protected": False,
     "label": "Desktop automation pipeline",
     "desc": "automation_* actions (cursor, dry-run, run, disarm)."},
    {"id": "pipe.desktop", "kind": "pipeline", "default": True, "protected": False,
     "label": "Desktop action pipeline",
     "desc": "open apps/URLs, search, media, volume, screenshots, windows, "
             "clipboard, overlay, vdesk."},
]

_BY_ID = {d["id"]: d for d in FLAG_DEFS}
_PROTECTED = {d["id"] for d in FLAG_DEFS if d["protected"]}


# ── storage ────────────────────────────────────────────────────────────────

def _load() -> dict:
    """Stored overrides (id → bool). Corrupt/missing → {} (all defaults ON)."""
    raw = None
    try:
        raw = config_repo.get(_STORE_KEY)
    except Exception:
        return {}
    if not isinstance(raw, dict):
        return {}
    out = {}
    for k, v in raw.items():
        if k in _BY_ID and isinstance(v, (bool, int)) and k not in _PROTECTED:
            out[k] = bool(v)
    return out


def _save(store: dict) -> None:
    # keep only known, non-protected, bool values — never store junk
    clean = {k: bool(v) for k, v in store.items()
             if k in _BY_ID and k not in _PROTECTED and isinstance(v, (bool, int))}
    config_repo.set(_STORE_KEY, clean)


# ── public API ─────────────────────────────────────────────────────────────

def defaults() -> dict:
    return {d["id"]: d["default"] for d in FLAG_DEFS}


def off_ids() -> set:
    """Ids currently switched OFF (everything else is ON, including unknown)."""
    store = _load()
    return {k for k, v in store.items() if not v}


def is_on(flag_id: str) -> bool:
    """True unless the owner explicitly switched this known flag off.
    Unknown id / missing store / corrupt data → True (never hides the app)."""
    if flag_id not in _BY_ID:
        return True
    if flag_id in _PROTECTED:
        return True
    return bool(_load().get(flag_id, _BY_ID[flag_id]["default"]))


def set_flag(flag_id: str, enabled: bool) -> tuple:
    """(ok, message). Turns a KNOWN, unprotected flag on/off."""
    if flag_id not in _BY_ID:
        return False, f"Unknown feature '{flag_id}'."
    if flag_id in _PROTECTED:
        return False, f"'{flag_id}' is locked — it can never be disabled."
    if not isinstance(enabled, bool):
        return False, "enabled must be true/false."
    store = _load()
    store[flag_id] = enabled
    _save(store)
    return True, f"{flag_id} {'enabled' if enabled else 'disabled'}."


def reset() -> dict:
    """Everything back ON. Returns the new state."""
    _save({})
    return state()


def defs() -> list:
    """Registry + live state, for the controls page and the app."""
    store = _load()
    out = []
    for d in FLAG_DEFS:
        on = d["default"] if d["protected"] else bool(store.get(d["id"], d["default"]))
        out.append({**d, "on": on})
    return out


def state() -> dict:
    return {d["id"]: d["on"] for d in defs()}


def counts() -> dict:
    st = state()
    return {"on": sum(1 for v in st.values() if v), "off": sum(1 for v in st.values() if not v),
            "total": len(st), "protected": sorted(_PROTECTED)}
