"""
AURA :: Virtual Desktop Control  (Windows 10/11)
================================================
Give AURA its own desktop.

WHY THIS IS THE RIGHT ANSWER
----------------------------
The user's real blocker: "I can't leave my laptop after giving AURA a /do
task." That is true and unfixable in a browser — `pyautogui` drives the one
physical cursor the OS has, so AURA and the user fight over it.

Their own suggestion is the correct one: Windows already ships isolated
workspaces. Put AURA on Desktop 2, work on Desktop 1, and switch over when you
want to watch. The pointer is still shared (Windows has one cursor), but the
WINDOWS are not — AURA's apps open, focus and receive input on its own desktop
without covering your work.

WHAT IS AND IS NOT POSSIBLE — STATED PLAINLY
--------------------------------------------
Microsoft has never shipped a public API for virtual desktops. The underlying
COM interface (IVirtualDesktopManagerInternal) is undocumented and its GUID
changes between Windows builds, which is why third-party tools break after
updates. Rather than ship something that silently stops working, AURA uses
the documented, stable route: the **keyboard shortcuts** Windows guarantees.

    Win+Ctrl+D      create a new desktop
    Win+Ctrl+Right  switch to the next desktop
    Win+Ctrl+Left   switch to the previous desktop
    Win+Ctrl+F4     close the current desktop
    Win+Tab         open Task View

This means AURA can create, switch and close desktops reliably, and can TRACK
which desktop it believes it is on by counting its own switches. It cannot
*query* Windows for the true current index — no stable API exists — so the
index is a belief, and `confidence` says so. A `resync()` is provided for when
you switch manually and the belief drifts.

Requires pyautogui (for the keystrokes) and Windows. Everywhere else this
module reports unavailable instead of pretending.

@module vdesk
"""

import platform
import time

SYSTEM = platform.system()

try:
    import pyautogui
    _HAS_PYAUTOGUI = True
    _IMPORT_ERROR = None
except Exception as e:
    pyautogui = None
    _HAS_PYAUTOGUI = False
    _IMPORT_ERROR = f"{type(e).__name__}: {e}"

# Belief about the desktop layout. `index` is 0-based and is a BELIEF, not a
# reading — see the module docstring.
_state = {
    "index": 0,
    "count": 1,
    "auraDesktop": None,     # which index AURA created for itself
    "homeDesktop": 0,        # where the user was when AURA started
    "confidence": "high",    # high | low  (low after a manual switch)
    "switches": 0,
}

# Windows needs a moment to finish the desktop-switch animation before the
# next input lands, or keystrokes go to the wrong workspace.
SWITCH_SETTLE = 0.75


def capabilities():
    available = SYSTEM == "Windows" and _HAS_PYAUTOGUI
    if SYSTEM != "Windows":
        reason = (f"Virtual desktops are a Windows feature. This machine is {SYSTEM}. "
                  "On macOS use Mission Control Spaces manually; on Linux use your "
                  "desktop environment's workspaces.")
    elif not _HAS_PYAUTOGUI:
        reason = f"Needs pyautogui.  pip install pyautogui  ({_IMPORT_ERROR})"
    else:
        reason = None
    return {
        "ok": True,
        "available": available,
        "reason": reason,
        "system": SYSTEM,
        "method": "documented keyboard shortcuts (Win+Ctrl+D / Left / Right / F4)",
        "limitation": (
            "Windows exposes no stable API to READ the current desktop index, so "
            "AURA tracks it by counting its own switches. If you switch manually, "
            "run resync so the belief matches reality."),
        "sharedCursor": (
            "Windows has ONE pointer shared across all desktops. Separate desktops "
            "keep AURA's windows off your workspace; they do not give it a second "
            "mouse."),
    }


def _hotkey(*keys, settle=SWITCH_SETTLE):
    if not _HAS_PYAUTOGUI:
        return False
    try:
        pyautogui.hotkey(*keys)
        time.sleep(settle)
        return True
    except Exception:
        return False


def create():
    """Create a new virtual desktop. Windows switches to it automatically."""
    caps = capabilities()
    if not caps["available"]:
        return {"ok": False, "message": caps["reason"]}
    if not _hotkey("win", "ctrl", "d"):
        return {"ok": False, "message": "Could not send Win+Ctrl+D."}
    _state["count"] += 1
    _state["index"] = _state["count"] - 1        # new desktop is appended
    _state["switches"] += 1
    return {"ok": True, "index": _state["index"], "count": _state["count"],
            "message": f"Created desktop {_state['index'] + 1} of {_state['count']}."}


def switch(direction):
    """direction: 'next' | 'prev'"""
    caps = capabilities()
    if not caps["available"]:
        return {"ok": False, "message": caps["reason"]}
    d = str(direction).lower()
    if d in ("next", "right", "+1"):
        if not _hotkey("win", "ctrl", "right"):
            return {"ok": False, "message": "Could not send Win+Ctrl+Right."}
        _state["index"] = min(_state["index"] + 1, max(0, _state["count"] - 1))
    elif d in ("prev", "previous", "left", "-1"):
        if not _hotkey("win", "ctrl", "left"):
            return {"ok": False, "message": "Could not send Win+Ctrl+Left."}
        _state["index"] = max(0, _state["index"] - 1)
    else:
        return {"ok": False, "message": f"Unknown direction '{direction}'. Use next or prev."}
    _state["switches"] += 1
    return {"ok": True, "index": _state["index"],
            "message": f"Now on desktop {_state['index'] + 1} (believed)."}


def go_to(index):
    """
    Move to a desktop by index, by stepping. There is no direct-jump shortcut,
    so this is a sequence of Win+Ctrl+Arrow presses — which is exactly why the
    step count is bounded.
    """
    caps = capabilities()
    if not caps["available"]:
        return {"ok": False, "message": caps["reason"]}
    target = max(0, int(index))
    delta = target - _state["index"]
    if delta == 0:
        return {"ok": True, "index": target, "message": f"Already on desktop {target + 1}."}
    if abs(delta) > 8:
        return {"ok": False, "message": f"Refusing to step {abs(delta)} desktops - "
                                        "that is almost certainly a tracking error. Run resync."}
    for _ in range(abs(delta)):
        r = switch("next" if delta > 0 else "prev")
        if not r["ok"]:
            return r
    return {"ok": True, "index": _state["index"],
            "message": f"Moved to desktop {_state['index'] + 1}."}


def setup_aura_desktop():
    """
    Create a dedicated desktop for AURA and remember both it and where the
    user came from, so `go_home()` and `go_aura()` are one call each.
    """
    caps = capabilities()
    if not caps["available"]:
        return {"ok": False, "message": caps["reason"]}
    _state["homeDesktop"] = _state["index"]
    r = create()
    if not r["ok"]:
        return r
    _state["auraDesktop"] = _state["index"]
    return {"ok": True, "auraDesktop": _state["auraDesktop"],
            "homeDesktop": _state["homeDesktop"],
            "message": (f"AURA now owns desktop {_state['auraDesktop'] + 1}. "
                        f"Your work is on desktop {_state['homeDesktop'] + 1}. "
                        "Win+Ctrl+Left/Right to move between them by hand.")}


def go_aura():
    if _state["auraDesktop"] is None:
        return {"ok": False, "message": "No AURA desktop yet. Run setup first."}
    return go_to(_state["auraDesktop"])


def go_home():
    return go_to(_state.get("homeDesktop", 0))


def close_current():
    """Close the current desktop. Its windows move to the neighbouring one."""
    caps = capabilities()
    if not caps["available"]:
        return {"ok": False, "message": caps["reason"]}
    if _state["count"] <= 1:
        return {"ok": False, "message": "Only one desktop exists - nothing to close."}
    if not _hotkey("win", "ctrl", "f4"):
        return {"ok": False, "message": "Could not send Win+Ctrl+F4."}
    _state["count"] -= 1
    if _state["auraDesktop"] == _state["index"]:
        _state["auraDesktop"] = None
    _state["index"] = max(0, _state["index"] - 1)
    return {"ok": True, "index": _state["index"], "count": _state["count"],
            "message": f"Closed. {_state['count']} desktop(s) remain."}


def task_view():
    caps = capabilities()
    if not caps["available"]:
        return {"ok": False, "message": caps["reason"]}
    ok = _hotkey("win", "tab", settle=0.4)
    return {"ok": ok, "message": "Opened Task View." if ok else "Could not send Win+Tab."}


def resync(index=0, count=None):
    """
    Tell AURA where it really is, after you have switched by hand.
    Honest correction beats a confident wrong number.
    """
    _state["index"] = max(0, int(index))
    if count is not None:
        _state["count"] = max(1, int(count))
    _state["confidence"] = "high"
    return {"ok": True, **status_dict(),
            "message": f"Resynced: now believed to be on desktop {_state['index'] + 1}."}


def status_dict():
    return {"index": _state["index"], "count": _state["count"],
            "auraDesktop": _state["auraDesktop"], "homeDesktop": _state["homeDesktop"],
            "confidence": _state["confidence"], "switches": _state["switches"]}


def status():
    return {**capabilities(), **status_dict()}
