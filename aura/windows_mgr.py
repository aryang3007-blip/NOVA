"""
AURA :: Window Manager
======================
Minimise the active window using the real OS window API.

WHY NOT "CLICK THE MINIMISE BUTTON"
-----------------------------------
Because it does not work. The button moves with window size, theme, DPI
scaling, maximised state, and title-bar style; some apps draw their own.
Clicking a coordinate is guessing, and a privacy feature that guesses will
one day click something else.

This uses `ShowWindow(hwnd, SW_MINIMIZE)` via `user32` through ctypes — the
same call Windows itself makes. No coordinates, no app names, no window
titles, no executable paths.

  Windows  ctypes -> user32.GetForegroundWindow / ShowWindow   (real API)
  macOS    AppleScript -> System Events "set miniaturized"     (real API)
  Linux    wmctrl / xdotool if present                          (honest miss)

Nothing is hardcoded per application. Where a platform cannot do this
properly, it says so instead of faking it.

@module windows_mgr
"""

import platform
import shutil
import subprocess

SYSTEM = platform.system()

SW_MINIMIZE = 6
SW_RESTORE = 9

_state = {"last_hwnd": None, "last_title": None, "minimised": 0}


def capabilities():
    """Can this machine really minimise the active window?"""
    if SYSTEM == "Windows":
        try:
            import ctypes  # noqa: F401
            return {"ok": True, "available": True, "reason": None, "system": SYSTEM,
                    "method": "user32.ShowWindow(hwnd, SW_MINIMIZE) via ctypes",
                    "usesCoordinates": False}
        except Exception as e:
            return {"ok": True, "available": False, "system": SYSTEM,
                    "reason": f"ctypes unavailable: {e}", "usesCoordinates": False}
    if SYSTEM == "Darwin":
        return {"ok": True, "available": bool(shutil.which("osascript")), "system": SYSTEM,
                "reason": None if shutil.which("osascript") else "osascript not found",
                "method": "AppleScript System Events (set miniaturized to true)",
                "usesCoordinates": False}
    tool = shutil.which("wmctrl") or shutil.which("xdotool")
    return {"ok": True, "available": bool(tool), "system": SYSTEM,
            "reason": None if tool else
                      "Needs wmctrl or xdotool.  sudo apt install wmctrl",
            "method": f"{tool} window minimise" if tool else None,
            "usesCoordinates": False}


def get_active_window():
    """
    Identify the focused window. Returns a stable id plus a human title so the
    trace can show WHAT was minimised, without ever matching on that title.
    """
    caps = capabilities()
    if not caps["available"]:
        return {"ok": False, "message": caps["reason"]}

    if SYSTEM == "Windows":
        try:
            import ctypes
            from ctypes import wintypes
            u = ctypes.windll.user32
            hwnd = u.GetForegroundWindow()
            if not hwnd:
                return {"ok": False, "message": "No foreground window."}
            n = u.GetWindowTextLengthW(hwnd)
            buf = ctypes.create_unicode_buffer(n + 1)
            u.GetWindowTextW(hwnd, buf, n + 1)
            pid = wintypes.DWORD()
            u.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            _state["last_hwnd"] = int(hwnd)
            _state["last_title"] = buf.value
            return {"ok": True, "windowId": int(hwnd), "title": buf.value,
                    "pid": int(pid.value),
                    "minimised": bool(u.IsIconic(hwnd))}
        except Exception as e:
            return {"ok": False, "message": f"GetForegroundWindow failed: {e}"}

    if SYSTEM == "Darwin":
        script = ('tell application "System Events" to get name of first '
                  'application process whose frontmost is true')
        try:
            out = subprocess.run(["osascript", "-e", script], capture_output=True,
                                 text=True, timeout=6)
            name = (out.stdout or "").strip()
            if not name:
                return {"ok": False, "message": (out.stderr or "no frontmost app").strip()[:160]}
            _state["last_title"] = name
            return {"ok": True, "windowId": name, "title": name}
        except Exception as e:
            return {"ok": False, "message": str(e)}

    # Linux
    if shutil.which("xdotool"):
        try:
            wid = subprocess.run(["xdotool", "getactivewindow"], capture_output=True,
                                 text=True, timeout=6).stdout.strip()
            if not wid:
                return {"ok": False, "message": "No active window."}
            name = subprocess.run(["xdotool", "getwindowname", wid], capture_output=True,
                                  text=True, timeout=6).stdout.strip()
            _state["last_hwnd"] = wid
            _state["last_title"] = name
            return {"ok": True, "windowId": wid, "title": name}
        except Exception as e:
            return {"ok": False, "message": str(e)}
    return {"ok": False, "message": capabilities()["reason"]}


def minimize_window(window_id=None):
    """Minimise a specific window by the id `get_active_window()` returned."""
    caps = capabilities()
    if not caps["available"]:
        return {"ok": False, "message": caps["reason"]}
    if window_id is None:
        return {"ok": False, "message": "No window id supplied."}

    if SYSTEM == "Windows":
        try:
            import ctypes
            u = ctypes.windll.user32
            hwnd = int(window_id)
            if not u.IsWindow(hwnd):
                return {"ok": False, "message": "That window no longer exists."}
            u.ShowWindow(hwnd, SW_MINIMIZE)
            _state["minimised"] += 1
            return {"ok": True, "windowId": hwnd,
                    "message": f"Minimised window {hwnd}."}
        except Exception as e:
            return {"ok": False, "message": f"ShowWindow failed: {e}"}

    if SYSTEM == "Darwin":
        script = (f'tell application "System Events" to tell process "{window_id}" '
                  'to set value of attribute "AXMinimized" of front window to true')
        try:
            r = subprocess.run(["osascript", "-e", script], capture_output=True,
                               text=True, timeout=8)
            if r.returncode != 0:
                return {"ok": False, "message": (r.stderr or "AppleScript failed").strip()[:180]}
            _state["minimised"] += 1
            return {"ok": True, "windowId": window_id, "message": f"Minimised {window_id}."}
        except Exception as e:
            return {"ok": False, "message": str(e)}

    if shutil.which("xdotool"):
        try:
            r = subprocess.run(["xdotool", "windowminimize", str(window_id)],
                               capture_output=True, text=True, timeout=6)
            if r.returncode != 0:
                return {"ok": False, "message": (r.stderr or "xdotool failed").strip()[:160]}
            _state["minimised"] += 1
            return {"ok": True, "windowId": window_id, "message": "Minimised."}
        except Exception as e:
            return {"ok": False, "message": str(e)}
    return {"ok": False, "message": capabilities()["reason"]}


def minimize_active_window():
    """
    The one Privacy Guard calls. Find the focused window, minimise it, and
    report which one — so the trace shows what happened without the caller
    ever having to name an application.
    """
    win = get_active_window()
    if not win.get("ok"):
        return win
    res = minimize_window(win["windowId"])
    if res.get("ok"):
        title = win.get("title") or "window"
        res["title"] = title
        res["message"] = f"Minimised “{title[:60]}”."
    return res


def restore_window(window_id=None):
    """Restore a minimised window."""
    if SYSTEM != "Windows":
        return {"ok": False, "message": f"Restore is only implemented on Windows (this is {SYSTEM})."}
    try:
        import ctypes
        hwnd = int(window_id if window_id is not None else (_state["last_hwnd"] or 0))
        if not hwnd:
            return {"ok": False, "message": "No window to restore."}
        ctypes.windll.user32.ShowWindow(hwnd, SW_RESTORE)
        return {"ok": True, "windowId": hwnd, "message": f"Restored window {hwnd}."}
    except Exception as e:
        return {"ok": False, "message": str(e)}


def focus_window(window_id=None):
    """Bring a window to the foreground and focus it."""
    if SYSTEM != "Windows":
        return {"ok": False, "message": f"Focus is only implemented on Windows (this is {SYSTEM})."}
    try:
        import ctypes
        hwnd = int(window_id or 0)
        if not hwnd or not ctypes.windll.user32.IsWindow(hwnd):
            return {"ok": False, "message": "That window no longer exists."}
        u = ctypes.windll.user32
        if u.IsIconic(hwnd):
            u.ShowWindow(hwnd, SW_RESTORE)
        u.SetForegroundWindow(hwnd)
        u.BringWindowToTop(hwnd)
        _state["last_hwnd"] = hwnd
        return {"ok": True, "windowId": hwnd, "message": f"Focused window {hwnd}."}
    except Exception as e:
        return {"ok": False, "message": str(e)}


def maximize_window(window_id=None):
    """Maximise a window."""
    if SYSTEM != "Windows":
        return {"ok": False, "message": f"Maximise is only implemented on Windows (this is {SYSTEM})."}
    try:
        import ctypes
        hwnd = int(window_id or 0)
        if not hwnd or not ctypes.windll.user32.IsWindow(hwnd):
            return {"ok": False, "message": "That window no longer exists."}
        ctypes.windll.user32.ShowWindow(hwnd, 3)  # SW_MAXIMIZE
        return {"ok": True, "windowId": hwnd, "message": f"Maximised window {hwnd}."}
    except Exception as e:
        return {"ok": False, "message": str(e)}


def close_window(window_id=None):
    """Send WM_CLOSE to a window cleanly."""
    if SYSTEM != "Windows":
        return {"ok": False, "message": f"Close is only implemented on Windows (this is {SYSTEM})."}
    try:
        import ctypes
        hwnd = int(window_id or 0)
        if not hwnd or not ctypes.windll.user32.IsWindow(hwnd):
            return {"ok": False, "message": "That window no longer exists."}
        ctypes.windll.user32.PostMessageW(hwnd, 0x0010, 0, 0)  # WM_CLOSE
        return {"ok": True, "windowId": hwnd, "message": f"Closed window {hwnd}."}
    except Exception as e:
        return {"ok": False, "message": str(e)}


def list_all_windows():
    """
    Enumerate all active visible application windows on the system.
    Returns list of { id, hwnd, title, process, pid, minimised, maximised, focused }.
    """
    if SYSTEM != "Windows":
        return {"ok": True, "windows": [], "count": 0, "system": SYSTEM}
    try:
        import ctypes
        from ctypes import wintypes
        try:
            import psutil
        except Exception:
            psutil = None

        u = ctypes.windll.user32
        foreground = u.GetForegroundWindow()
        windows = []

        WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

        def enum_handler(hwnd, lparam):
            if not u.IsWindow(hwnd) or not u.IsWindowVisible(hwnd):
                return True
            length = u.GetWindowTextLengthW(hwnd)
            if length == 0:
                return True
            buf = ctypes.create_unicode_buffer(length + 1)
            u.GetWindowTextW(hwnd, buf, length + 1)
            title = buf.value.strip()
            if not title:
                return True
            # Skip hidden/internal Windows shell artifacts
            if title in ("Program Manager", "Default IME", "MSCTFIME UI", "Windows Input Experience"):
                return True

            pid = wintypes.DWORD()
            u.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            pname = ""
            if psutil and pid.value:
                try:
                    pname = psutil.Process(pid.value).name()
                except Exception:
                    pname = ""

            windows.append({
                "id": int(hwnd),
                "hwnd": int(hwnd),
                "title": title,
                "pid": int(pid.value),
                "process": pname,
                "minimised": bool(u.IsIconic(hwnd)),
                "maximised": bool(u.IsZoomed(hwnd)),
                "focused": bool(hwnd == foreground),
            })
            return True

        cb = WNDENUMPROC(enum_handler)
        u.EnumWindows(cb, 0)

        return {"ok": True, "windows": windows, "count": len(windows), "system": SYSTEM}
    except Exception as e:
        return {"ok": False, "message": f"Window enumeration failed: {e}", "windows": []}


def status():
    return {**capabilities(), "lastWindow": _state["last_title"],
            "minimisedCount": _state["minimised"]}
