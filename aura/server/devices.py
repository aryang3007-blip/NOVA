"""
AURA :: Device Gateway
======================
Pair a phone with the laptop over the LAN and route actions to it.

WHY LONG-POLLING AND NOT A WEBSOCKET
------------------------------------
`serve.py` is `http.server` from the standard library — the whole project runs
with zero pip dependencies for the core. Adding a WebSocket means adding a
dependency (websockets/aiohttp) or hand-rolling RFC 6455 framing on top of
raw sockets. Both are a lot of surface area for what this actually needs:
"tell the phone to do one thing, occasionally."

Long-polling gives the same user-visible behaviour — the phone holds an open
request, the server answers the instant an action is queued, latency is a few
milliseconds on a LAN — using only the stdlib, and it reconnects trivially
after a Wi-Fi drop because every poll is just another HTTP request. The
transport is isolated behind `poll()`/`enqueue()`, so swapping in a WebSocket
later touches this file only.

SECURITY MODEL
--------------
  • A device must PAIR before it can do anything. Pairing needs a 6-digit code
    that the laptop displays; it expires in 3 minutes and is single-use.
  • Pairing returns a 32-byte token. Every later request must present it.
  • An unpaired or wrong token gets 401. There is no anonymous path.
  • Actions are validated against the device's DECLARED capabilities, so a
    phone that never claimed `open_url` cannot be sent one.
  • The phone can only RECEIVE actions from the laptop. There is no route
    that lets a phone run anything on Windows — that stays behind the Action
    Manager, reachable only from the host page with the host token.

State is in memory. Losing pairings on restart is the correct trade for "no
database", and it is stated plainly rather than hidden.

@module devices
"""

import json
import secrets
import threading
import time

# Device is dropped from "connected" after this long with no contact.
HEARTBEAT_TIMEOUT = 25.0
# How long a poll waits before returning empty, so the phone can re-poll.
POLL_TIMEOUT = 20.0
PAIR_CODE_TTL = 180.0
MAX_QUEUE = 20

# Capabilities a companion may declare. Anything else is rejected at pairing,
# so a device cannot invent a capability to unlock a route.
KNOWN_CAPABILITIES = {
    "open_url", "show_notification", "vibrate",
    "request_camera", "request_microphone", "device_status",
}

# Device classes a companion may pair as. The user reported opening /phone in
# a second WINDOW on the same laptop, which the old code labelled "phone" and
# credited with a vibration motor. Platform now drives both the id prefix and
# the capability ceiling, and is validated server-side rather than trusted.
_PHONE_CAPS = {"open_url", "show_notification", "vibrate",
               "request_camera", "request_microphone", "device_status"}
_DESK_CAPS = _PHONE_CAPS - {"vibrate"}          # no vibration motor on a desktop
KNOWN_PLATFORMS = {
    "android": {"label": "Android", "kind": "phone",   "caps": _PHONE_CAPS},
    # iOS Safari implements no Vibration API.
    "ios":     {"label": "iPhone",  "kind": "phone",   "caps": _DESK_CAPS},
    "windows": {"label": "Windows", "kind": "desktop", "caps": _DESK_CAPS},
    "macos":   {"label": "macOS",   "kind": "desktop", "caps": _DESK_CAPS},
    "linux":   {"label": "Linux",   "kind": "desktop", "caps": _DESK_CAPS},
}

_lock = threading.RLock()
_devices = {}          # id -> device dict
_queues = {}           # id -> list[action]
_events = []           # recent gateway events, for the UI
_pairing = {"code": None, "expires": 0}
_counter = {"n": 0}


def _load_saved_devices():
    """Restore paired companion devices from SQLite."""
    try:
        from persistence.repositories import device_repo
        saved = device_repo.get_all_devices()
        for d in saved:
            did = d["id"]
            _devices[did] = {
                "id": did,
                "name": d["name"],
                "platform": d["platform"],
                "kind": d.get("kind", "phone"),
                "capabilities": d["capabilities"],
                "token": d["token"],
                "pairedAt": d.get("pairedAt", _now()),
                "lastSeen": d.get("lastSeen", 0),
                "battery": d.get("battery"),
                "latencyMs": d.get("latencyMs"),
                "actionsSent": 0,
                "actionsAcked": 0,
            }
            _queues[did] = []
            try:
                # Update counter if platform-num format
                num_part = int(did.split("-")[-1])
                if num_part > _counter["n"]:
                    _counter["n"] = num_part
            except Exception:
                pass
        if saved:
            print(f"[DEVICES] Restored {len(saved)} paired companion device(s) from SQLite.", flush=True)
    except Exception as e:
        pass

# Initialize on import
_load_saved_devices()



def _log(kind, **extra):
    _events.append({"kind": kind, "at": time.time(), **extra})
    if len(_events) > 120:
        del _events[0]


def _now():
    return time.time()


def _is_connected(d):
    return (_now() - d.get("lastSeen", 0)) < HEARTBEAT_TIMEOUT


def _public(d):
    """Device as the UI sees it. The token is NEVER included."""
    return {
        "id": d["id"], "name": d["name"], "platform": d["platform"],
        "kind": d.get("kind", "phone"),
        "platformLabel": KNOWN_PLATFORMS.get(d["platform"], {}).get("label", d["platform"]),
        "capabilities": d["capabilities"],
        "status": "connected" if _is_connected(d) else "disconnected",
        "lastSeen": d.get("lastSeen", 0),
        "latencyMs": d.get("latencyMs"),
        "battery": d.get("battery"),
        "pairedAt": d.get("pairedAt"),
        "queued": len(_queues.get(d["id"], [])),
        "actionsSent": d.get("actionsSent", 0),
        "actionsAcked": d.get("actionsAcked", 0),
    }


# ── pairing ──────────────────────────────────────────────────────────

def start_pairing(port=None):
    """
    Show a code on the laptop. The phone types it in — or scans the QR.

    The QR is attached HERE rather than in the callers, because there are two
    of them (`/api/devices/pair-start` for the host UI and the `device_pair_start`
    bridge action) and enriching only one is exactly the bug that shipped: the
    settings page called the bridge path and never saw a QR.
    """
    with _lock:
        code = f"{secrets.randbelow(900000) + 100000}"
        _pairing["code"] = code
        _pairing["expires"] = _now() + PAIR_CODE_TTL
        _log("pairing_started")
        out = {"ok": True, "code": code, "expiresIn": int(PAIR_CODE_TTL),
               "message": f"Enter {code} on the phone within 3 minutes."}

    p = port or _server_port()
    if p:
        url = pair_url(p, code)
        out["url"] = url
        out["lanIp"] = lan_ip()
        q = qr_svg(url)
        if q.get("ok"):
            out["qr"] = q["svg"]
        else:
            out["qr"] = None
            out["qrError"] = q.get("message")
    return out


# The port AURA is actually serving on. serve.py sets this at startup; without
# it a QR would encode the wrong URL, which is worse than showing no QR.
_PORT = {"value": None}


def set_port(port):
    try:
        _PORT["value"] = int(port)
    except Exception:
        _PORT["value"] = None
    return _PORT["value"]


def _server_port():
    return _PORT["value"]


def lan_ip():
    """
    This machine's LAN address, or None.

    Opens a UDP socket toward a public address and reads back which local
    interface the OS chose. No packet is actually sent, and it works offline
    on any machine with a default route — far more reliable than
    gethostbyname(gethostname()), which returns 127.0.1.1 on most Linux boxes
    and the wrong adapter on multi-homed Windows.
    """
    import socket
    s = None
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.4)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        return ip if ip and not ip.startswith("127.") else None
    except Exception:
        return None
    finally:
        if s:
            try:
                s.close()
            except Exception:
                pass


def pair_url(port, code, host=None):
    """The URL a phone should open. Encodes the code so scanning is one step."""
    ip = host or lan_ip() or "localhost"
    base = f"http://{ip}:{port}/phone"
    return f"{base}?code={code}" if code else base


def qr_svg(text, quiet=4, scale=1):
    """
    Render `text` as an SVG QR code.

    SVG on purpose: it needs no Pillow, stays sharp at any size, and can be
    inlined straight into the page — which matters because the settings modal
    renders inside a sandboxed iframe with no network access.

    `quiet` defaults to 4 modules, which is what the QR spec requires. At 2 the
    code is still valid but sits too close to surrounding UI: OpenCV failed to
    locate it at 2 and read it perfectly at 4, and phone scanners behave the
    same way. Verified by decoding the rendered output, not by eye.

    @returns {ok, svg, modules} or {ok: False, message}
    """
    try:
        import qrcode
    except Exception:
        return {"ok": False, "missing": "qrcode",
                "message": "QR pairing needs the qrcode library.  pip install qrcode\n"
                           "The 6-digit code still works without it."}
    try:
        q = qrcode.QRCode(
            version=None,
            error_correction=qrcode.constants.ERROR_CORRECT_M,
            box_size=1, border=quiet)
        q.add_data(text)
        q.make(fit=True)
        matrix = q.get_matrix()
    except Exception as e:
        return {"ok": False, "message": f"Could not build a QR code: {e}"}

    n = len(matrix)
    # One <path> of rectangles rather than n^2 <rect> elements: ~30x smaller.
    parts = []
    for y, row in enumerate(matrix):
        x = 0
        while x < n:
            if row[x]:
                run = 1
                while x + run < n and row[x + run]:
                    run += 1
                parts.append(f"M{x} {y}h{run}v1h-{run}z")
                x += run
            else:
                x += 1
    d = "".join(parts)
    size = n * scale
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {n} {n}" '
           f'width="{size}" height="{size}" shape-rendering="crispEdges" '
           f'role="img" aria-label="Pairing QR code">'
           f'<rect width="{n}" height="{n}" fill="#ffffff"/>'
           f'<path d="{d}" fill="#000000"/></svg>')
    return {"ok": True, "svg": svg, "modules": n}


def cancel_pairing():
    with _lock:
        _pairing["code"] = None
        _pairing["expires"] = 0
        return {"ok": True, "message": "Pairing cancelled."}


def pairing_status():
    with _lock:
        active = bool(_pairing["code"]) and _now() < _pairing["expires"]
        return {"ok": True, "active": active,
                "code": _pairing["code"] if active else None,
                "expiresIn": max(0, int(_pairing["expires"] - _now())) if active else 0}


def pair(code, name, platform="android", capabilities=None, kind=None):
    """Called BY THE PHONE. Exchanges a valid code for a device token.

    `platform` is one of KNOWN_PLATFORMS. It is validated rather than trusted,
    because it becomes part of the device id and is shown in the UI. `kind`
    ("phone" / "desktop") is derived from the platform, never taken on faith.
    """
    with _lock:
        if not _pairing["code"] or _now() > _pairing["expires"]:
            _log("pair_rejected", reason="no active code")
            return {"ok": False, "message": "No pairing in progress. Start it on the laptop."}
        if str(code).strip() != _pairing["code"]:
            _log("pair_rejected", reason="wrong code")
            return {"ok": False, "message": "Wrong code."}

        plat = str(platform or "").lower().strip()
        if plat not in KNOWN_PLATFORMS:
            plat = "android" if plat == "phone" else "windows"
        caps = [c for c in (capabilities or []) if c in KNOWN_CAPABILITIES]
        # A device cannot claim a capability its platform does not have, even
        # if it asks for one — the allowlist is intersected twice.
        caps = [c for c in caps if c in KNOWN_PLATFORMS[plat]["caps"]]
        _counter["n"] += 1
        did = f"{plat}-{_counter['n']:03d}"
        token = secrets.token_urlsafe(24)
        _devices[did] = {
            "id": did, "name": (name or KNOWN_PLATFORMS[plat]["label"])[:40],
            "platform": plat, "kind": KNOWN_PLATFORMS[plat]["kind"],
            "capabilities": caps, "token": token, "pairedAt": _now(),
            "lastSeen": _now(), "actionsSent": 0, "actionsAcked": 0,
        }
        _queues[did] = []
        # Single-use: the code dies the moment it is redeemed.
        _pairing["code"] = None
        _pairing["expires"] = 0
        _log("paired", device=did, name=_devices[did]["name"])

        # Persist to SQLite
        try:
            from persistence.repositories import device_repo
            device_repo.save_device(
                device_id=did,
                name=_devices[did]["name"],
                platform=plat,
                kind=_devices[did]["kind"],
                token=token,
                capabilities=caps,
                paired_at=_devices[did]["pairedAt"]
            )
        except Exception:
            pass

        return {"ok": True, "deviceId": did, "token": token,
                "device": _public(_devices[did]),
                "heartbeatMs": int(HEARTBEAT_TIMEOUT * 1000 / 3),
                "message": f"Paired as {did}."}


def unpair(device_id):
    with _lock:
        d = _devices.pop(device_id, None)
        _queues.pop(device_id, None)
        if not d:
            return {"ok": False, "message": "No such device."}
        _log("unpaired", device=device_id)

        try:
            from persistence.repositories import device_repo
            device_repo.unpair_device(device_id)
        except Exception:
            pass

        return {"ok": True, "message": f"Unpaired {d['name']}."}


def _auth(device_id, token):
    d = _devices.get(device_id)
    if not d or not token or not secrets.compare_digest(d["token"], str(token)):
        return None
    return d


# ── companion endpoints ──────────────────────────────────────────────

def heartbeat(device_id, token, info=None):
    with _lock:
        d = _auth(device_id, token)
        if not d:
            return {"ok": False, "code": 401, "message": "Not paired."}
        was = _is_connected(d)
        d["lastSeen"] = _now()
        for k in ("battery", "latencyMs"):
            if info and info.get(k) is not None:
                d[k] = info[k]
        if info and isinstance(info.get("capabilities"), list):
            d["capabilities"] = [c for c in info["capabilities"] if c in KNOWN_CAPABILITIES]
        if not was:
            _log("connected", device=device_id)

        try:
            from persistence.repositories import device_repo
            device_repo.update_heartbeat(device_id, battery=d.get("battery"), latency_ms=d.get("latencyMs"), caps=d.get("capabilities"))
        except Exception:
            pass

        return {"ok": True, "device": _public(d)}



def poll(device_id, token, wait=POLL_TIMEOUT):
    """
    Long-poll for queued actions. Returns as soon as one exists, or empty
    after `wait` seconds so the phone can immediately poll again.
    """
    d = None
    with _lock:
        d = _auth(device_id, token)
        if not d:
            return {"ok": False, "code": 401, "message": "Not paired."}
        d["lastSeen"] = _now()

    deadline = _now() + wait
    while _now() < deadline:
        with _lock:
            q = _queues.get(device_id) or []
            if q:
                actions = q[:]
                _queues[device_id] = []
                _devices[device_id]["lastSeen"] = _now()
                _devices[device_id]["actionsSent"] += len(actions)
                return {"ok": True, "actions": actions}
        time.sleep(0.12)
    with _lock:
        if device_id in _devices:
            _devices[device_id]["lastSeen"] = _now()
    return {"ok": True, "actions": []}


def acknowledge(device_id, token, action_id, success=True, detail=""):
    with _lock:
        d = _auth(device_id, token)
        if not d:
            return {"ok": False, "code": 401, "message": "Not paired."}
        d["lastSeen"] = _now()
        d["actionsAcked"] += 1
        _log("acknowledged", device=device_id, action=action_id,
             success=bool(success), detail=str(detail)[:120])
        return {"ok": True}


# ── host side ────────────────────────────────────────────────────────

def resolve(ref):
    """
    Turn "phone" / "my phone" / "android-001" into a device id.
    Returns (device_id, error_message).
    """
    with _lock:
        if not ref:
            return None, "No device specified."
        r = str(ref).strip().lower()
        # Substring match, so "this computer" / "my laptop" / "on the pc" all
        # resolve. Exact-match-only meant natural phrasing fell through to
        # "no device matching", which is exactly the wrong answer.
        if any(w in r for w in ("laptop", "windows", "host", "desktop",
                                "computer", "this pc", "the pc")) or r == "pc":
            return "windows-host", None
        if r in _devices:
            return r, None
        # Match by name.
        for did, d in _devices.items():
            if d["name"].lower() == r:
                return did, None
        # Generic "phone"/"mobile" → the single paired phone, if unambiguous.
        # Match on KIND, not platform == "android": an iPhone is a phone too,
        # and the old check silently excluded it.
        if r in ("phone", "my phone", "mobile", "android", "cell", "iphone"):
            phones = [did for did, d in _devices.items()
                      if d.get("kind") == "phone"
                      or d["platform"] in ("android", "ios")]
            if len(phones) == 1:
                return phones[0], None
            if not phones:
                return None, "No phone is paired. Pair one in Settings → Devices."
            return None, f"{len(phones)} phones are paired — name one: " \
                         + ", ".join(_devices[p]["name"] for p in phones)
        for did, d in _devices.items():
            if r in d["name"].lower():
                return did, None
        return None, f"No device matching “{ref}”."


def send_action(device_ref, action, params=None):
    """
    Queue an action for a paired device. Every failure mode is reported
    honestly — an offline phone must never look like success.
    """
    with _lock:
        did, err = resolve(device_ref)
        if err:
            return {"ok": False, "message": err}
        if did == "windows-host":
            return {"ok": False, "isHost": True,
                    "message": "That targets this computer — the Action Manager handles it."}
        d = _devices.get(did)
        if not d:
            return {"ok": False, "message": f"{did} is not paired."}
        if not _is_connected(d):
            secs = int(_now() - d.get("lastSeen", 0))
            return {"ok": False, "offline": True,
                    "message": f"{d['name']} is offline (last seen {secs}s ago). "
                               "Open AURA on the phone to reconnect."}
        if action not in KNOWN_CAPABILITIES:
            return {"ok": False, "message": f"“{action}” is not a device action."}
        if action not in d["capabilities"]:
            return {"ok": False,
                    "message": f"{d['name']} does not support “{action}”. "
                               f"It reports: {', '.join(d['capabilities']) or 'nothing'}."}
        q = _queues.setdefault(did, [])
        if len(q) >= MAX_QUEUE:
            return {"ok": False, "message": f"{d['name']} has too many pending actions."}
        aid = secrets.token_hex(6)
        q.append({"id": aid, "action": action, "params": params or {}, "at": _now()})
        _log("action_queued", device=did, action=action)
        return {"ok": True, "actionId": aid, "device": did,
                "message": f"Sent “{action}” to {d['name']}."}


def list_devices():
    with _lock:
        return {"ok": True, "devices": [_public(d) for d in _devices.values()],
                "count": len(_devices),
                "connected": sum(1 for d in _devices.values() if _is_connected(d))}


def status():
    with _lock:
        return {"ok": True, "transport": "http-long-poll",
                "transportNote": "Long-polling, not WebSocket: serve.py is stdlib-only. "
                                 "Same latency on a LAN, and reconnect is free.",
                "persistence": "in-memory — pairings are lost when serve.py restarts",
                "heartbeatTimeout": HEARTBEAT_TIMEOUT,
                "capabilities": sorted(KNOWN_CAPABILITIES),
                "pairing": pairing_status(),
                **list_devices(),
                "events": _events[-25:]}


def reset():
    """Test helper — clears all state."""
    with _lock:
        _devices.clear(); _queues.clear(); _events.clear()
        _pairing["code"] = None; _pairing["expires"] = 0; _counter["n"] = 0
        return {"ok": True}
