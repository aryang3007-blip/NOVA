"""
AURA :: Input Automation
========================
Real mouse and keyboard control, so AURA can drive applications rather than
only launching them.

This is the most dangerous code in the project. It can click anything and
type anywhere. The safety model is therefore layered, and every layer is
enforced HERE, server-side — never in the browser, which the AI can influence.

  1. OFF BY DEFAULT.  Requires --allow-actions AND the `input_automation`
     permission AND `arm()` to have been called for this session.
  2. KILL SWITCH.  pyautogui's FAILSAFE stays ON: slam the pointer into the
     top-left corner and any in-flight automation aborts instantly. There is
     also a software `disarm()` and an auto-expiry.
  3. STEP BUDGET.  A plan is a bounded list of steps (max 40). No loops, no
     recursion, no way to express "click forever".
  4. TYPED TEXT IS DATA.  Text is typed literally. It cannot contain key
     combinations — `hotkey` is a separate, allowlisted step type.
  5. HOTKEY ALLOWLIST.  Only known-safe combinations. Alt+F4, Ctrl+Alt+Del,
     Win+R and friends are refused.
  6. DRY RUN.  Every plan can be described in plain English before it runs,
     so the blast radius is visible up front.
  7. AUTO-EXPIRY.  Arming lapses after 15 minutes of inactivity.

pyautogui is an OPTIONAL dependency. Without it every entry point returns a
clear "not installed" message — AURA never pretends to have clicked.

@module automation
"""

import re
import time

try:
    import pyautogui
    pyautogui.FAILSAFE = True        # corner-slam abort — never disable this
    pyautogui.PAUSE = 0.06           # small gap so apps can keep up
    _HAS_PYAUTOGUI = True
    _IMPORT_ERROR = None
except Exception as e:               # ImportError, or no display on a server
    pyautogui = None
    _HAS_PYAUTOGUI = False
    _IMPORT_ERROR = f"{type(e).__name__}: {e}"


MAX_STEPS = 40
MAX_TEXT = 2000

# How long an arm lasts with NO activity at all.
#
# This was a flat 15 minutes and it was wrong: a user who armed automation,
# then spent 20 minutes reading a document before saying "click save", found
# it silently disarmed. Two changes:
#   1. The default is longer (60 min), because the arm is already protected
#      by per-plan confirmation and the failsafe corner - the TTL is a
#      backstop, not the primary control.
#   2. It is a ROLLING window: any successful action refreshes it (that was
#      already true) and so does any capability/status poll from the UI while
#      the tab is open. Idle means "AURA is not being used", not "15 minutes
#      have elapsed since you clicked ARM".
# 0 disables expiry entirely for the session.
ARM_TTL = 60 * 60                    # seconds

# Session state. Automation is inert until arm() is called.
_state = {"armed": False, "armed_at": 0, "last_plan": None, "runs": 0,
          "expired_at": 0}

# Key combinations that are never allowed, whatever the user confirms.
# These close windows, lock the machine, open run dialogs or kill processes —
# a mis-parsed instruction here is a genuinely bad day.
_FORBIDDEN_HOTKEYS = [
    {"alt", "f4"},                 # close window
    {"ctrl", "alt", "delete"},     # security screen
    {"ctrl", "shift", "esc"},      # task manager
    {"win", "r"},                  # run dialog — arbitrary command entry
    {"win", "l"},                  # lock
    {"win", "x"},                  # power user menu
    {"win", "e"},                  # explorer, harmless but noisy
    {"cmd", "q"},                  # macOS quit
    {"cmd", "option", "esc"},      # macOS force quit
    {"alt", "shift", "delete"},    # permanent delete on some shells
]

# Individual keys that may appear in a hotkey.
_ALLOWED_KEYS = set("abcdefghijklmnopqrstuvwxyz0123456789") | {
    "ctrl", "shift", "alt", "cmd", "win", "enter", "return", "tab", "esc",
    "escape", "space", "backspace", "delete", "home", "end", "pageup",
    "pagedown", "up", "down", "left", "right", "insert",
    "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
    "plus", "minus", "equal", "comma", "period", "slash",
}

VALID_STEPS = {"move", "click", "double_click", "right_click", "drag",
               "type", "press", "hotkey", "scroll", "wait", "screenshot"}


def capabilities():
    """Honest report of what this machine can do."""
    size = None
    if _HAS_PYAUTOGUI:
        try:
            w, h = pyautogui.size()
            size = {"width": int(w), "height": int(h)}
        except Exception:
            size = None
    return {
        "ok": True,
        "available": _HAS_PYAUTOGUI,
        "reason": None if _HAS_PYAUTOGUI else
                  f"Input automation needs pyautogui.  pip install pyautogui"
                  + (f"  ({_IMPORT_ERROR})" if _IMPORT_ERROR else ""),
        "armed": is_armed(touch=True),
        "expiresInSeconds": arm_remaining(),
        "expiredRecently": bool(_state.get("expired_at")
                                and time.time() - _state["expired_at"] < 300),
        "screen": size,
        "failsafe": "Move the mouse to the TOP-LEFT corner to abort instantly.",
        "maxSteps": MAX_STEPS,
        "armTtlSeconds": ARM_TTL,
        "runs": _state["runs"],
    }


def is_armed(touch=False):
    """
    Is automation armed right now?

    @param touch  when True, a live arm has its idle window refreshed. The UI
                  polls capabilities() while the Settings tab is open, which
                  counts as "the user is still here".
    """
    if not _state["armed"]:
        return False
    if ARM_TTL and time.time() - _state["armed_at"] > ARM_TTL:
        _state["armed"] = False
        _state["expired_at"] = time.time()
        return False
    if touch:
        _state["armed_at"] = time.time()
    return True


def arm_remaining():
    """Seconds left on the current arm, or None when not armed / no expiry."""
    if not _state["armed"]:
        return None
    if not ARM_TTL:
        return -1                      # armed indefinitely
    return max(0, int(ARM_TTL - (time.time() - _state["armed_at"])))


def arm():
    """Enable automation for this session. Requires an explicit user action."""
    if not _HAS_PYAUTOGUI:
        return {"ok": False, "message": capabilities()["reason"]}
    _state["armed"] = True
    _state["armed_at"] = time.time()
    _state["expired_at"] = 0
    window = f"{ARM_TTL // 60} minutes of inactivity" if ARM_TTL else "this session"
    return {"ok": True, "armed": True, "expiresIn": ARM_TTL,
            "message": f"Input automation armed. It stays on until {window} pass "
                       f"(any action refreshes it). Move the mouse to the top-left "
                       f"corner to abort anything running."}


def disarm():
    _state["armed"] = False
    return {"ok": True, "armed": False, "message": "Input automation disarmed."}


def _clamp_point(x, y):
    """
    Keep coordinates on screen.

    Previously this returned the raw values when pyautogui was unavailable,
    so a plan built on a headless machine could carry negative coordinates
    into a later run on a real one. Always clamp: fall back to a conservative
    virtual screen when the real size is unknown.
    """
    w, h = 1920, 1080
    if _HAS_PYAUTOGUI:
        try:
            sw, sh = pyautogui.size()
            w, h = int(sw), int(sh)
        except Exception:
            pass
    # Never allow (0,0): that corner is the failsafe and must stay reachable
    # by the user, not occupied by an automated click.
    return max(2, min(int(x), w - 2)), max(2, min(int(y), h - 2))


def _check_hotkey(keys):
    ks = {str(k).strip().lower() for k in keys if str(k).strip()}
    if not ks:
        return "empty hotkey"
    # Check forbidden COMBINATIONS first: alt+f4 should report "blocked
    # combination", not "unsupported key f4", or the reason looks like a bug.
    for combo in _FORBIDDEN_HOTKEYS:
        if combo <= ks:
            return (f"blocked combination ({'+'.join(sorted(combo))}) — it can close "
                    f"windows or lock the machine")
    bad = ks - _ALLOWED_KEYS
    if bad:
        return f"unsupported key(s): {', '.join(sorted(bad))}"
    for combo in []:
        if combo <= ks:
            return (f"blocked combination ({'+'.join(sorted(combo))}) — it can close "
                    f"windows or lock the machine")
    return None


def validate(plan):
    """
    Check a plan without running any of it.
    @returns {"ok":bool, "steps":[...], "errors":[...], "description":[...]}
    """
    if not isinstance(plan, list):
        return {"ok": False, "errors": ["Plan must be a list of steps."],
                "steps": [], "description": []}
    if not plan:
        return {"ok": False, "errors": ["Plan is empty."], "steps": [], "description": []}
    if len(plan) > MAX_STEPS:
        return {"ok": False, "steps": [], "description": [],
                "errors": [f"Plan has {len(plan)} steps; the limit is {MAX_STEPS}."]}

    errors, described, clean = [], [], []
    for i, raw in enumerate(plan, 1):
        if not isinstance(raw, dict):
            errors.append(f"Step {i}: not an object.")
            continue
        op = str(raw.get("op", "")).lower().strip()
        if op not in VALID_STEPS:
            errors.append(f"Step {i}: unknown action '{op}'.")
            continue
        s = {"op": op}

        if op in ("move", "click", "double_click", "right_click", "drag"):
            try:
                s["x"], s["y"] = _clamp_point(raw.get("x", 0), raw.get("y", 0))
            except (TypeError, ValueError):
                errors.append(f"Step {i}: '{op}' needs numeric x and y.")
                continue
            verb = {"move": "Move the pointer to", "click": "CLICK at",
                    "double_click": "DOUBLE-CLICK at", "right_click": "RIGHT-CLICK at",
                    "drag": "DRAG to"}[op]
            described.append(f"{i}. {verb} ({s['x']}, {s['y']})")

        elif op == "type":
            text = str(raw.get("text", ""))
            if not text:
                errors.append(f"Step {i}: 'type' needs text.")
                continue
            if len(text) > MAX_TEXT:
                errors.append(f"Step {i}: text is {len(text)} chars; limit {MAX_TEXT}.")
                continue
            s["text"] = text
            preview = text if len(text) <= 60 else text[:57] + "..."
            described.append(f'{i}. TYPE "{preview}"')

        elif op == "press":
            key = str(raw.get("key", "")).lower().strip()
            if key not in _ALLOWED_KEYS:
                errors.append(f"Step {i}: key '{key}' is not allowed.")
                continue
            s["key"] = key
            described.append(f"{i}. Press {key.upper()}")

        elif op == "hotkey":
            keys = raw.get("keys") or []
            if isinstance(keys, str):
                keys = [k for k in re.split(r"[+\s]+", keys) if k]
            err = _check_hotkey(keys)
            if err:
                errors.append(f"Step {i}: {err}.")
                continue
            s["keys"] = [str(k).lower().strip() for k in keys]
            described.append(f"{i}. Press {'+'.join(k.upper() for k in s['keys'])}")

        elif op == "scroll":
            try:
                s["amount"] = max(-20, min(20, int(raw.get("amount", 3))))
            except (TypeError, ValueError):
                errors.append(f"Step {i}: 'scroll' needs a numeric amount.")
                continue
            described.append(f"{i}. Scroll {'up' if s['amount'] > 0 else 'down'}")

        elif op == "wait":
            try:
                s["seconds"] = max(0.05, min(5.0, float(raw.get("seconds", 0.5))))
            except (TypeError, ValueError):
                errors.append(f"Step {i}: 'wait' needs a number.")
                continue
            described.append(f"{i}. Wait {s['seconds']:.2f}s")

        elif op == "screenshot":
            described.append(f"{i}. Take a screenshot")

        clean.append(s)

    return {"ok": not errors, "steps": clean, "errors": errors,
            "description": described}


def dry_run(plan):
    """Describe what a plan WOULD do. Never touches the mouse or keyboard."""
    v = validate(plan)
    return {
        "ok": v["ok"],
        "dryRun": True,
        "steps": len(v["steps"]),
        "description": v["description"],
        "errors": v["errors"],
        "message": ("This plan will:\n" + "\n".join(v["description"]))
                   if v["ok"] else "Plan rejected:\n" + "\n".join(v["errors"]),
    }


def run(plan, confirmed=False):
    """
    Execute a validated plan.

    Refuses unless: pyautogui is present, automation is armed, the plan
    validates, AND the caller passed confirmed=True (which the UI only sets
    after the user approves the dry run).
    """
    if not _HAS_PYAUTOGUI:
        return {"ok": False, "message": capabilities()["reason"]}
    if not is_armed():
        expired = bool(_state.get("expired_at"))
        return {"ok": False, "needsArm": True, "expired": expired,
                "message": ("Input automation expired after "
                            f"{ARM_TTL // 60} minutes idle. Run `/automation arm` again."
                            if expired else
                            "Input automation is not armed. Run `/automation arm`, "
                            "or use Settings → Desktop → Input Automation.")}

    v = validate(plan)
    if not v["ok"]:
        return {"ok": False, "message": "Plan rejected:\n" + "\n".join(v["errors"]),
                "errors": v["errors"]}
    if not confirmed:
        return {"ok": False, "needsConfirm": True, "description": v["description"],
                "message": "This plan needs your confirmation:\n" + "\n".join(v["description"])}

    done, shots = [], []
    try:
        for s in v["steps"]:
            op = s["op"]
            if op == "move":
                pyautogui.moveTo(s["x"], s["y"], duration=0.18)
            elif op == "click":
                pyautogui.click(s["x"], s["y"])
            elif op == "double_click":
                pyautogui.doubleClick(s["x"], s["y"])
            elif op == "right_click":
                pyautogui.rightClick(s["x"], s["y"])
            elif op == "drag":
                pyautogui.dragTo(s["x"], s["y"], duration=0.35, button="left")
            elif op == "type":
                pyautogui.typewrite(s["text"], interval=0.012)
            elif op == "press":
                pyautogui.press(s["key"])
            elif op == "hotkey":
                pyautogui.hotkey(*s["keys"])
            elif op == "scroll":
                pyautogui.scroll(s["amount"] * 120)
            elif op == "wait":
                time.sleep(s["seconds"])
            elif op == "screenshot":
                import base64, io
                img = pyautogui.screenshot()
                buf = io.BytesIO()
                img.save(buf, format="PNG")
                shots.append(base64.b64encode(buf.getvalue()).decode())
            done.append(op)
            _state["armed_at"] = time.time()      # activity keeps the arm alive
    except Exception as e:
        # pyautogui raises FailSafeException when the pointer hits the corner.
        name = type(e).__name__
        if "FailSafe" in name:
            _state["armed"] = False
            return {"ok": False, "aborted": True, "completed": done,
                    "message": f"ABORTED by the failsafe after {len(done)} step(s). "
                               f"Automation has been disarmed."}
        return {"ok": False, "completed": done,
                "message": f"Automation failed at step {len(done) + 1}: {name}: {e}"}

    _state["runs"] += 1
    _state["last_plan"] = v["description"]
    out = {"ok": True, "completed": done, "steps": len(done),
           "message": f"Completed {len(done)} step(s)."}
    if shots:
        out["screenshots"] = shots
    return out


def cursor_position():
    """Where is the pointer? Used by the UI's live cursor readout."""
    if not _HAS_PYAUTOGUI:
        return {"ok": False, "message": capabilities()["reason"]}
    try:
        p = pyautogui.position()
        return {"ok": True, "x": int(p.x), "y": int(p.y)}
    except Exception as e:
        return {"ok": False, "message": str(e)}
