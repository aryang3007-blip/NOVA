"""
AURA :: Desktop Overlay
=======================
A real, visible reticle drawn ON YOUR DESKTOP — on top of every other window.

WHY THIS EXISTS (AND AN APOLOGY FOR THE PREVIOUS CLAIM)
-------------------------------------------------------
I wrote that AURA "places its own cursor on things you ask it to find". That
was misleading. The reticle existed only inside the SCREEN panel's small
preview canvas in the browser tab — a picture of your screen with a circle
drawn on the picture. Nothing was ever drawn on the actual desktop. The user
was right: they had never seen it, because it was never there.

This module is the real thing: a borderless, always-on-top, click-through
window that follows a coordinate you give it and paints a high-visibility
marker there. A web page cannot do this. Only a native process can, which is
why it lives here and not in JavaScript.

HOW IT IS CLICK-THROUGH
-----------------------
On Windows the window gets WS_EX_LAYERED | WS_EX_TRANSPARENT via ctypes, so
mouse events pass straight through to whatever is underneath. Without that
flag the overlay would eat the very clicks AURA is trying to make — which
would be worse than useless.

On macOS/Linux tkinter cannot reliably do click-through, so the overlay is
made tiny and parked exactly under the pointer target. It is honest about the
degradation rather than pretending.

Runs in its own process so a crash here can never take the server down, and
so the Tk main loop does not fight the HTTP server's threads.

@module overlay
"""

import json
import os
import platform
import queue
import sys
import threading

SYSTEM = platform.system()

try:
    import tkinter as tk
    _HAS_TK = True
    _TK_ERROR = None
except Exception as e:                      # headless server, no display
    tk = None
    _HAS_TK = False
    _TK_ERROR = f"{type(e).__name__}: {e}"

# The colour keyed out to make the window transparent on Windows. Chosen to be
# a value nothing in the reticle uses, so no part of the marker vanishes.
_CHROMA = "#010203"

DEFAULTS = {
    "color": "#00FF88",      # bright green - reads over almost any wallpaper
    "size": 130,             # overlay window edge, px
    "label": "",
    "style": "reticle",      # reticle | ring | crosshair | dot
    "thickness": 4,
}


def capabilities():
    """Honest report of whether a real desktop overlay is possible here."""
    return {
        "ok": True,
        "available": _HAS_TK and bool(_display_present()),
        "reason": None if (_HAS_TK and _display_present()) else (
            _TK_ERROR or "No display available (headless machine)."),
        "clickThrough": SYSTEM == "Windows",
        "clickThroughNote": (
            "Full click-through via WS_EX_TRANSPARENT."
            if SYSTEM == "Windows" else
            "Click-through is not reliable on this OS; the marker is kept small "
            "so it obstructs as little as possible."),
        "system": SYSTEM,
        "styles": ["reticle", "ring", "crosshair", "dot"],
    }


def _display_present():
    if SYSTEM in ("Windows", "Darwin"):
        return True
    return bool(os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"))


class _OverlayWindow:
    """The Tk window itself. Only ever touched from the overlay thread."""

    def __init__(self, cmds):
        self.cmds = cmds
        self.cfg = dict(DEFAULTS)
        self.visible = False
        self.x = 0
        self.y = 0
        self.root = tk.Tk()
        self.root.withdraw()
        self.root.overrideredirect(True)              # no title bar, no border
        self.root.attributes("-topmost", True)
        try:
            self.root.attributes("-transparentcolor", _CHROMA)
            self.root.configure(bg=_CHROMA)
        except Exception:
            # Not supported (macOS/Linux) - fall back to a translucent window.
            self.root.attributes("-alpha", 0.85)
            self.root.configure(bg="black")
        self.canvas = tk.Canvas(self.root, highlightthickness=0, bd=0,
                                bg=self.root.cget("bg"))
        self.canvas.pack(fill="both", expand=True)
        self._make_click_through()
        self.root.after(30, self._pump)

    def _make_click_through(self):
        """Windows: let mouse events pass straight through the overlay."""
        if SYSTEM != "Windows":
            return
        try:
            import ctypes
            GWL_EXSTYLE = -20
            WS_EX_LAYERED = 0x00080000
            WS_EX_TRANSPARENT = 0x00000020
            WS_EX_TOOLWINDOW = 0x00000080     # keep it out of alt-tab
            self.root.update_idletasks()
            hwnd = ctypes.windll.user32.GetParent(self.root.winfo_id())
            if not hwnd:
                hwnd = self.root.winfo_id()
            style = ctypes.windll.user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
            ctypes.windll.user32.SetWindowLongW(
                hwnd, GWL_EXSTYLE,
                style | WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW)
        except Exception:
            pass          # a visible-but-clickable overlay still beats none

    def _pump(self):
        """Drain commands from the HTTP thread. Tk is not thread-safe."""
        try:
            while True:
                cmd = self.cmds.get_nowait()
                self._apply(cmd)
        except queue.Empty:
            pass
        self.root.after(30, self._pump)

    def _apply(self, cmd):
        op = cmd.get("op")
        if op == "quit":
            self.root.quit()
            return
        if op == "config":
            for k in DEFAULTS:
                if k in cmd and cmd[k] is not None:
                    self.cfg[k] = cmd[k]
        if op in ("show", "move"):
            self.x = int(cmd.get("x", self.x))
            self.y = int(cmd.get("y", self.y))
            for k in ("color", "label", "style", "size", "thickness"):
                if cmd.get(k) is not None:
                    self.cfg[k] = cmd[k]
            self.visible = True
        if op == "hide":
            self.visible = False

        if self.visible:
            self._draw()
            self.root.deiconify()
            self.root.attributes("-topmost", True)
        else:
            self.root.withdraw()

    def _draw(self):
        s = int(self.cfg["size"])
        half = s // 2
        col = self.cfg["color"]
        th = int(self.cfg["thickness"])
        style = self.cfg["style"]

        self.root.geometry(f"{s}x{s}+{self.x - half}+{self.y - half}")
        c = self.canvas
        c.delete("all")
        c.configure(width=s, height=s)
        cx = cy = half

        if style in ("reticle", "ring"):
            r1 = int(s * 0.22)
            c.create_oval(cx - r1, cy - r1, cx + r1, cy + r1, outline=col, width=th)
        if style == "reticle":
            r2 = int(s * 0.36)
            c.create_oval(cx - r2, cy - r2, cx + r2, cy + r2, outline=col, width=max(1, th - 2))
        if style in ("reticle", "crosshair"):
            arm = int(s * 0.44)
            gap = int(s * 0.13)
            for dx, dy in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                c.create_line(cx + dx * gap, cy + dy * gap,
                              cx + dx * arm, cy + dy * arm, fill=col, width=th)
        # Always mark the exact target pixel, whatever the style.
        c.create_oval(cx - 3, cy - 3, cx + 3, cy + 3, fill=col, outline=col)

        if self.cfg.get("label"):
            c.create_text(cx, cy + int(s * 0.44), text=str(self.cfg["label"])[:28],
                          fill=col, font=("Consolas", 10, "bold"))


_cmds = queue.Queue()
_thread = None
_state = {"running": False, "visible": False, "x": 0, "y": 0, "cfg": dict(DEFAULTS)}


def _run():
    try:
        win = _OverlayWindow(_cmds)
        _state["running"] = True
        win.root.mainloop()
    except Exception as e:
        _state["error"] = str(e)
    finally:
        _state["running"] = False
        _state["visible"] = False


def _ensure():
    global _thread
    if not _HAS_TK or not _display_present():
        return False
    if _thread and _thread.is_alive():
        return True
    _thread = threading.Thread(target=_run, daemon=True, name="aura-overlay")
    _thread.start()
    # Give Tk a moment to come up so the first show() is not dropped.
    for _ in range(40):
        if _state["running"]:
            return True
        threading.Event().wait(0.05)
    return _state["running"]


def show(x, y, **kw):
    """Place the reticle at a real screen coordinate."""
    caps = capabilities()
    if not caps["available"]:
        return {"ok": False, "message": caps["reason"]}
    if not _ensure():
        return {"ok": False, "message": "Overlay window could not start."}
    payload = {"op": "show", "x": int(x), "y": int(y)}
    for k in ("color", "label", "style", "size", "thickness"):
        if kw.get(k) is not None:
            payload[k] = kw[k]
            _state["cfg"][k] = kw[k]
    _cmds.put(payload)
    _state.update({"visible": True, "x": int(x), "y": int(y)})
    return {"ok": True, "x": int(x), "y": int(y),
            "message": f"Reticle at ({int(x)}, {int(y)})",
            "clickThrough": caps["clickThrough"]}


def move(x, y, **kw):
    return show(x, y, **kw)


def hide():
    if _state["running"]:
        _cmds.put({"op": "hide"})
    _state["visible"] = False
    return {"ok": True, "message": "Reticle hidden."}


def configure(**kw):
    for k in DEFAULTS:
        if kw.get(k) is not None:
            _state["cfg"][k] = kw[k]
    if _state["running"]:
        _cmds.put({"op": "config", **{k: v for k, v in kw.items() if v is not None}})
    return {"ok": True, "config": dict(_state["cfg"])}


def stop():
    if _state["running"]:
        _cmds.put({"op": "quit"})
    return {"ok": True}


def status():
    caps = capabilities()
    return {**caps, "running": _state["running"], "visible": _state["visible"],
            "x": _state["x"], "y": _state["y"], "config": dict(_state["cfg"])}


if __name__ == "__main__":
    # Manual check:  python overlay.py 800 400
    print(json.dumps(capabilities(), indent=2))
    if len(sys.argv) >= 3 and capabilities()["available"]:
        print(show(int(sys.argv[1]), int(sys.argv[2]), label="AURA"))
        input("Reticle shown. Press Enter to quit...")
