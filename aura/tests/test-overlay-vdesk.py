"""
AURA :: desktop overlay + virtual desktop control
=================================================
Both are Windows/display-dependent, so in this sandbox the important thing to
prove is that they REPORT HONESTLY rather than pretending — that was the exact
failure the user caught ("I have never seen AURA's cursor").

Where a real display exists (xvfb) the overlay is exercised for real.
"""
import os
import sys
import json

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

PASS = FAIL = 0


def ok(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  \033[32m✓\033[0m {name}" + (f"  \033[90m{detail}\033[0m" if detail else ""))
    else:
        FAIL += 1
        print(f"  \033[31m✗\033[0m {name}  \033[90m{detail}\033[0m")


import overlay
import vdesk
import bridge

print("\n\033[36m▸ OVERLAY — honest capability reporting\033[0m")
caps = overlay.capabilities()
ok("capabilities() responds", caps.get("ok") is True)
ok("declares availability explicitly", isinstance(caps.get("available"), bool),
   str(caps.get("available")))
ok("when unavailable it says WHY",
   caps["available"] or bool(caps.get("reason")), str(caps.get("reason"))[:70])
ok("reports click-through support per OS", "clickThrough" in caps,
   f"{caps['system']} → {caps['clickThrough']}")
ok("click-through is only claimed on Windows",
   caps["clickThrough"] == (caps["system"] == "Windows"))
ok("offers marker styles", len(caps.get("styles", [])) >= 3, str(caps.get("styles")))

print("\n\033[36m▸ OVERLAY — never pretends to have drawn\033[0m")
r = overlay.show(500, 300, label="test")
if caps["available"]:
    ok("show() succeeds on a real display", r["ok"], str(r)[:80])
    ok("it reports the coordinate", r.get("x") == 500 and r.get("y") == 300)
    st = overlay.status()
    ok("status says visible", st["visible"] is True)
    ok("hide() works", overlay.hide()["ok"])
    ok("status says hidden", overlay.status()["visible"] is False)
    overlay.stop()
else:
    ok("show() REFUSES with no display", not r["ok"], str(r.get("message"))[:70])
    ok("the refusal names the cause",
       "display" in str(r.get("message", "")).lower(), str(r.get("message"))[:70])
    ok("status reports not-visible", overlay.status()["visible"] is False)
    ok("hide() is safe when never shown", overlay.hide()["ok"])

cfg = overlay.configure(color="#FF00FF", style="crosshair", size=200)
ok("configure() accepts a colour", cfg["config"]["color"] == "#FF00FF")
ok("configure() accepts a style", cfg["config"]["style"] == "crosshair")
ok("default colour is high-visibility", overlay.DEFAULTS["color"] == "#00FF88")

print("\n\033[36m▸ VIRTUAL DESKTOPS — honest about Windows-only\033[0m")
vcaps = vdesk.capabilities()
ok("capabilities() responds", vcaps.get("ok") is True)
ok("available only on Windows with pyautogui",
   vcaps["available"] == (vcaps["system"] == "Windows" and vdesk._HAS_PYAUTOGUI))
if not vcaps["available"]:
    ok("explains why not", bool(vcaps.get("reason")), str(vcaps["reason"])[:80])
    ok("suggests the platform equivalent",
       vcaps["system"] == "Windows" or "Mission Control" in vcaps["reason"]
       or "workspaces" in vcaps["reason"], str(vcaps["reason"])[:80])

ok("documents the tracking limitation", "no stable API" in vcaps["limitation"]
   or "READ the current desktop" in vcaps["limitation"], vcaps["limitation"][:70])
ok("is explicit that the CURSOR is still shared",
   "ONE pointer" in vcaps["sharedCursor"], vcaps["sharedCursor"][:70])
ok("uses documented shortcuts, not undocumented COM",
   "keyboard shortcuts" in vcaps["method"], vcaps["method"])

print("\n\033[36m▸ VIRTUAL DESKTOPS — refuses rather than guessing\033[0m")
for fn, name in [(vdesk.create, "create"), (vdesk.setup_aura_desktop, "setup"),
                 (vdesk.go_aura, "go_aura"), (vdesk.close_current, "close")]:
    r = fn()
    if not vcaps["available"]:
        ok(f"{name}() refuses off-Windows", not r["ok"], str(r.get("message"))[:50])

st = vdesk.status()
ok("status exposes the believed index", "index" in st, str(st.get("index")))
ok("status exposes confidence", st.get("confidence") in ("high", "low"))
ok("resync corrects the belief", vdesk.resync(3, 5)["index"] == 3)
ok("resync updates the count", vdesk.status()["count"] == 5)
vdesk.resync(0, 1)

# go_to must refuse an absurd step count rather than mashing arrow keys.
vdesk._state["index"] = 0
vdesk._state["count"] = 50
if vcaps["available"]:
    r = vdesk.go_to(40)
    ok("go_to refuses an absurd jump", not r["ok"], str(r.get("message"))[:60])
else:
    ok("go_to refuses off-Windows", not vdesk.go_to(40)["ok"])
vdesk.resync(0, 1)

print("\n\033[36m▸ BRIDGE DISPATCH\033[0m")
for action in ["overlay_status", "vdesk_status"]:
    r = bridge.dispatch(action, {})
    ok(f"{action} is routed", isinstance(r, dict) and r.get("ok") is not None,
       json.dumps(r)[:60])
ok("unknown overlay sub-action is rejected",
   bridge.dispatch("overlay_wibble", {})["ok"] is False)
ok("unknown vdesk sub-action is rejected",
   bridge.dispatch("vdesk_wibble", {})["ok"] is False)
r = bridge.dispatch("overlay_show", {"x": 10, "y": 20})
ok("overlay_show is routed and answers", isinstance(r, dict) and "ok" in r,
   json.dumps(r)[:70])

print(f"\n  \033[32mPASS {PASS}\033[0m  FAIL {FAIL}")
sys.exit(1 if FAIL else 0)
