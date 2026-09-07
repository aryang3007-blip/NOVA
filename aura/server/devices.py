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
# Per-device action policy: id -> {"allow": set[str], "deny": set[str]}.
# In-memory like the live heartbeats (pairings persist; policies are a
# runtime security posture and are deliberately NOT durable).
_policy = {}


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
    p = _policy.get(d["id"], {})
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
        "policy": {"allow": sorted(p.get("allow") or []),
                   "deny": sorted(p.get("deny") or [])},
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
        _policy.pop(device_id, None)
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
        # Per-device policy gate (allow/deny, "all" = wildcard). A DENY
        # always wins; a non-empty ALLOW list means ONLY those actions pass.
        pol = _policy.get(did, {})
        deny = pol.get("deny") or set()
        allow = pol.get("allow") or set()
        if action in deny or "all" in deny:
            return {"ok": False, "denied": True,
                    "message": f"Denied by device policy: “{action}” is blocked "
                               f"on {d['name']}. Lift it with /devices deny <device> none."}
        if allow and action not in allow and "all" not in allow:
            return {"ok": False, "denied": True,
                    "message": f"Denied by device policy: “{action}” is not on "
                               f"{d['name']}'s allowlist. Add it with "
                               f"/devices allow <device> {action}."}
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


# ── per-device action policy ────────────────────────────────────────────
# DENY wins over ALLOW. "all" is the wildcard. An empty ALLOW means
# everything not DENYed is allowed (default, fail-open for trust).
VALID_POLICY_ACTIONS = KNOWN_CAPABILITIES | {"all", "none"}


def _policy_dict(did):
    return _policy.setdefault(did, {"allow": set(), "deny": set()})


def set_policy(device_id, action, mode, enabled=True):
    """
    Add/remove an action on a device's allow/deny list.

    mode: "allow" | "deny"  (enabled=True → add, False → remove)
    action: a KNOWN_CAPABILITY, "all" (wildcard) or "none" (clear the list).
    Returns {ok, message, policy}.
    """
    with _lock:
        d = _devices.get(device_id)
        if not d:
            return {"ok": False, "message": f"{device_id} is not paired."}
        a = str(action or "").strip().lower()
        if a not in VALID_POLICY_ACTIONS:
            return {"ok": False,
                    "message": f"Unknown action '{a}'. Valid: "
                               f"{', '.join(sorted(VALID_POLICY_ACTIONS))}."}
        if mode not in ("allow", "deny"):
            return {"ok": False, "message": "mode must be 'allow' or 'deny'."}
        pol = _policy_dict(device_id)
        if a == "none":
            pol[mode].clear()
        elif enabled:
            pol[mode].add(a)
        else:
            pol[mode].discard(a)
        _log("policy_changed", device=device_id, mode=mode, action=a,
             enabled=bool(enabled))
        return {"ok": True, "device": device_id,
                "message": f"{'Cleared' if a == 'none' else ('Granted' if enabled else 'Removed')} "
                           f"{'ALLOW' if mode == 'allow' else 'DENY'} "
                           f"for “{a}” on {d['name']}.",
                "policy": {"allow": sorted(pol["allow"]),
                           "deny": sorted(pol["deny"])}}


def clear_policy(device_id):
    """Remove every allow/deny rule for a device (back to default-allowed)."""
    with _lock:
        d = _devices.get(device_id)
        if not d:
            return {"ok": False, "message": f"{device_id} is not paired."}
        _policy.pop(device_id, None)
        _log("policy_cleared", device=device_id)
        return {"ok": True, "message": f"Policy cleared on {d['name']} — "
                                       "all supported actions allowed."}


def policy_status(device_id=None):
    """Show the policy matrix: one device, or every paired device."""
    with _lock:
        if device_id:
            d = _devices.get(device_id)
            if not d:
                return {"ok": False, "message": f"{device_id} is not paired."}
            p = _policy.get(device_id, {"allow": set(), "deny": set()})
            return {"ok": True, "devices": [_public(d)]}
        return {"ok": True, "devices": [_public(d) for d in _devices.values()],
                "count": len(_devices)}


# ── device commands (canonical, one function for every UI) ─────────────────
# The chat /devices command, the bridge device_command action and the
# terminal /phone command ALL go through devices.command() — never forked.
# The companion executes exactly these actions (js/phone.js): open_url,
# show_notification, vibrate, request_camera, request_microphone,
# device_status. "Apps" on a phone = URL shortcuts it can open; it cannot
# launch installed native apps — stated, not hidden.
PHONE_APPS = {
    "google":    ("https://www.google.com",       "Web search"),
    "youtube":   ("https://m.youtube.com",        "Video"),
    "maps":      ("https://maps.google.com",      "Maps / directions"),
    "gmail":     ("https://mail.google.com",      "Mail"),
    "whatsapp":  ("https://web.whatsapp.com",     "Messaging (web client)"),
    "chatgpt":   ("https://chatgpt.com",          "AI chat"),
    "wikipedia": ("https://en.m.wikipedia.org",   "Reference"),
    "translate": ("https://translate.google.com", "Translation"),
    "calendar":  ("https://calendar.google.com",  "Calendar"),
    "drive":     ("https://drive.google.com",     "Files"),
    "photos":    ("https://photos.google.com",    "Photos"),
    "news":      ("https://news.google.com",      "News"),
}

_CMD_USAGE = (
    "DEVICE COMMANDS\n"
    "  list | status              paired devices + transport\n"
    "  pair | pair-cancel         start / cancel pairing (6-digit code)\n"
    "  apps                       phone-openable shortcut catalog\n"
    "  battery [device]           battery from the device heartbeat\n"
    "  caps [device]              what the device declared it can do\n"
    "  open <device> <name|url>   open a shortcut or a full http(s) URL\n"
    "  notify <device> <text>     show a notification on the device\n"
    "  vibrate <device> [ms]      vibrate (motor devices only)\n"
    "  locate [device]            find it: vibrate + notification\n"
    "  camera | mic [device]      request camera / microphone access\n"
    "  ping [device]              device_status round trip\n"
    "  unpair <device>            forget a device\n"
    "  allow <device> <action>    add to the device allowlist\n"
    "  deny <device> <action>     block an action (deny always wins; none = clear)\n"
    "  policy [device]            show the per-device allow/deny matrix\n"
    "  policy-clear <device>      remove every rule, back to default-allowed\n"
    "<device> defaults to the single paired phone."
)


def _find(ref):
    """Resolve a device ref → (public dict | None, error | None)."""
    did, err = resolve(ref or "phone")
    if err:
        return None, err
    dev = next((d for d in list_devices().get("devices", []) if d.get("id") == did), None)
    if dev is None:
        return None, f"{did} is not paired."
    return dev, None


def _cmd_device_dev(dev):
    caps = ", ".join(dev.get("capabilities") or []) or "none declared"
    bat = f"{dev.get('battery')}%" if dev.get("battery") is not None else "no battery report"
    lat = f"{dev.get('latencyMs')} ms" if dev.get("latencyMs") is not None else "latency -"
    state = "connected" if dev.get("status") == "connected" else "offline"
    return (f"  • {dev.get('id')} \"{dev.get('name')}\" — {state} · "
            f"battery {bat} · {lat} · sent {dev.get('actionsSent', 0)}/"
            f"acked {dev.get('actionsAcked', 0)}\n"
            f"    caps: {caps}")


def command(sub="help", arg=""):
    """ONE variablized device command.

    sub: list|status|pair|pair-cancel|apps|battery|caps|open|notify|vibrate|
        locate|camera|mic|ping|unpair|help
    arg: whatever follows (device refs default to the single paired phone).
    Returns {"ok": bool, "message": str} — plain text, safe for chat and CLI.
    """
    sub = str(sub or "help").lower().strip()
    arg = str(arg or "").strip()
    # Tolerant call form: command("open phone youtube") works the same as
    # command("open", "phone youtube") — one function, convenient from tests,
    # the bridge and both UIs.
    if " " in sub:
        sub, extra = sub.split(maxsplit=1)
        arg = f"{extra} {arg}".strip()
    out = []

    def _send_pretty(ref, action, params):
        r = send_action(ref, action, params)
        return f"  {'✓ ' if r.get('ok') else '✗ '}{r.get('message', '')}"

    if sub in ("help", ""):
        st = status()
        out.append("DEVICE COMMANDS")
        out.append(f"  Transport: {st.get('transport')} · paired {st.get('count', 0)}, "
                   f"{st.get('connected', 0)} connected")
        act = st.get("pairing", {})
        if act.get("active"):
            out.append(f"  Pairing: active — code {act.get('code')} ({act.get('expiresIn')}s left)")
        out.append(f"  Device actions: {', '.join(st.get('capabilities') or [])}")
        out.append("")
        out.append(_CMD_USAGE)
        return {"ok": True, "message": "\n".join(out)}

    if sub in ("list", "status"):
        st = list_devices()
        devs = st.get("devices", [])
        out.append(f"PAIRED DEVICES ({st.get('count', 0)}, "
                   f"{st.get('connected', 0)} connected)")
        if not devs:
            out.append("  No devices paired. Run: /devices pair, then enter the "
                       "code on the device (/phone over your LAN).")
        for d in devs:
            out.append(_cmd_device_dev(d))
        if sub == "status":
            out.append(f"  Transport: {status().get('transport')} "
                       f"(heartbeat timeout {int(HEARTBEAT_TIMEOUT)}s)")
        return {"ok": True, "message": "\n".join(out)}

    if sub == "pair":
        r = start_pairing()
        if not r.get("ok"):
            return {"ok": False, "message": "Pairing failed: " + str(r.get("message", "unknown"))}
        out.append("PAIRING STARTED")
        out.append(f"  Code: {r['code']}  (valid {r.get('expiresIn', 180)}s, single use)")
        if r.get("url"):
            out.append(f"  Open: {r['url']}")
        out.append("  On the device: open /phone, choose the platform, enter the code.")
        return {"ok": True, "message": "\n".join(out)}

    if sub == "pair-cancel":
        r = cancel_pairing()
        return {"ok": True, "message": r.get("message", "Pairing cancelled.")}

    if sub == "apps":
        out.append("PHONE-OPENABLE SHORTCUTS (hardcoded catalog)")
        for name, (url, what) in sorted(PHONE_APPS.items()):
            out.append(f"  {name:<12} -> {url}  ({what})")
        out.append("  The companion executes open_url only — it cannot launch")
        out.append("  installed native apps. Open one with: /devices open <device> <name>")
        return {"ok": True, "message": "\n".join(out)}

    if sub == "battery":
        dev, err = _find(arg)
        if err:
            return {"ok": False, "message": err}
        if dev.get("status") != "connected":
            return {"ok": False, "message": f"{dev['name']} is offline — open AURA "
                                            "on the device to reconnect."}
        if dev.get("battery") is None:
            return {"ok": True, "message": f"{dev['name']}: no battery report yet — "
                                           "the heartbeat sends it within ~7s of the "
                                           "device being open."}
        lat = f" · latency {dev['latencyMs']} ms" if dev.get("latencyMs") else ""
        return {"ok": True, "message": f"{dev['name']} battery: {dev.get('battery')}%{lat}"}

    if sub == "caps":
        dev, err = _find(arg)
        if err:
            return {"ok": False, "message": err}
        caps = ", ".join(dev.get("capabilities") or []) or "none declared"
        return {"ok": True, "message": f"{dev['id']} \"{dev['name']}\" "
                                       f"({dev.get('platformLabel')}) can do: {caps}"}

    if sub == "unpair":
        dev, err = _find(arg)
        if err:
            return {"ok": False, "message": err}
        r = unpair(dev["id"])
        return {"ok": True, "message": r.get("message", "Unpaired.")}

    # ── per-device policy: allow / deny / policy / policy-clear ──────────
    if sub in ("allow", "deny", "policy-clear"):
        toks = arg.split()
        if not toks:
            return {"ok": False, "message": f"Usage: /devices {sub} <device> <action|none|all>"}
        # First token is the device ONLY when it resolves (same rule as the
        # action commands) — so "allow open_url" defaults to the phone.
        first_resolves = bool(resolve(toks[0])[0])
        if first_resolves and len(toks) > 1:
            ref, rest = toks[0], toks[1:]
        else:
            ref, rest = "phone", toks
        dev, err = _find(ref)
        if err:
            return {"ok": False, "message": err}
        if sub == "policy-clear":
            r = clear_policy(dev["id"])
            return {"ok": True, "message": r.get("message", "Policy cleared.")}
        if not rest:
            return {"ok": False,
                    "message": f"Usage: /devices {sub} <device> <action>\n"
                               f"Actions: {', '.join(sorted(VALID_POLICY_ACTIONS))}"}
        r = set_policy(dev["id"], rest[0], sub)
        return {"ok": r.get("ok", False), "message": r.get("message", "")}

    if sub == "policy":
        dev, err = _find(arg) if arg else (None, None)
        if err:
            return {"ok": False, "message": err}
        st = policy_status(dev["id"] if dev else None)
        if not st.get("ok"):
            return {"ok": False, "message": st.get("message", "Policy unavailable.")}
        devs = st.get("devices", [])
        if not devs:
            out.append("DEVICE POLICY")
            out.append("  No devices paired — nothing to protect yet.")
            return {"ok": True, "message": "\n".join(out)}
        out.append("DEVICE POLICY (allowlist wins only when non-empty; deny always wins)")
        for d in devs:
            pol = d.get("policy") or {}
            allow = ", ".join(pol.get("allow") or []) or "— (everything allowed)"
            deny = ", ".join(pol.get("deny") or []) or "—"
            out.append(f"  • {d['id']} \"{d['name']}\"")
            out.append(f"      allow: {allow}")
            out.append(f"      deny:  {deny}")
        out.append("  Change with: /devices allow|deny <device> <action> · policy-clear <device>")
        return {"ok": True, "message": "\n".join(out)}

    if sub in ("open", "notify", "vibrate", "locate", "camera", "mic", "ping"):
        if sub in ("camera", "mic", "ping", "locate"):
            dev, err = _find(arg)
            if err:
                return {"ok": False, "message": err}
            ref, payload = dev["id"], ""
            if sub == "camera":
                return {"ok": True, "message": _send_pretty(ref, "request_camera", {})}
            if sub == "mic":
                return {"ok": True, "message": _send_pretty(ref, "request_microphone", {})}
            if sub == "ping":
                return {"ok": True, "message": _send_pretty(ref, "device_status", {})}
            # locate: vibrate + notify when the device supports them.
            caps = set(dev.get("capabilities") or [])
            notes = []
            if "vibrate" in caps:
                r_v = send_action(ref, "vibrate", {"ms": 800})
                notes.append(f"  {'✓ ' if r_v.get('ok') else '✗ '}"
                             f"{'vibrated 800ms' if r_v.get('ok') else r_v.get('message', '')}")
            if "show_notification" in caps:
                r_n = send_action(ref, "show_notification",
                                  {"title": "AURA", "body": f"Find me — {dev['name']}!"})
                notes.append(f"  {'✓ ' if r_n.get('ok') else '✗ '}"
                             f"{'notification: Find me — ' + dev['name'] + '!' if r_n.get('ok') else r_n.get('message', '')}")
            if not notes:
                return {"ok": False, "message":
                        f"{dev['name']} cannot vibrate or notify (caps: "
                        f"{', '.join(caps) or 'none'})"}
            return {"ok": True, "message": f"  Locating {dev['name']}:\n" + "\n".join(notes)}

        # open / notify / vibrate take "<device> <payload>"; the device can
        # be omitted entirely (defaults to the single paired phone). The first
        # token is treated as a device ONLY if it really resolves — so free
        # text like "notify hello there" still reaches the phone.
        toks = arg.split()
        if not toks:
            return {"ok": False, "message": f"Usage: /devices {sub} <device> <payload>"}
        first_is_app_or_url = (sub == "open" and
                               (toks[0].lower() in PHONE_APPS or
                                toks[0].startswith("http")))
        first_resolves = bool(resolve(toks[0])[0])
        if first_is_app_or_url:
            ref, payload = "phone", arg
        elif first_resolves and len(toks) > 1:
            ref, payload = toks[0], " ".join(toks[1:]).strip()
        elif first_resolves and sub == "open":
            return {"ok": False,
                    "message": "Usage: /devices open <device> <name|url>"}
        else:
            ref, payload = "phone", arg
        if sub == "open":
            url = payload if _re_match_url(payload) else None
            if url is None:
                hit = PHONE_APPS.get(payload.strip().lower())
                if hit:
                    url = hit[0]
                else:
                    return {"ok": False, "message": f"“{payload}” is not in the hardcoded "
                                                    "catalog — pass a full http(s) URL, "
                                                    "or see /devices apps."}
            line = _send_pretty(ref, "open_url", {"url": url})
            return {"ok": True, "message": line + (f"  ({url})" if "✓" in line else "")}
        if sub == "notify":
            return {"ok": True, "message": _send_pretty(ref, "show_notification",
                                                        {"title": "AURA", "body": payload})}
        # vibrate
        import re as _re
        m = _re.search(r"\d+", payload)
        ms = int(m.group()) if m else 220
        return {"ok": True, "message": _send_pretty(ref, "vibrate", {"ms": ms})}

    return {"ok": False, "message":
            f"Unknown device subcommand '{sub}'. " + _CMD_USAGE}


def _re_match_url(s):
    return bool(s and (s.startswith("http://") or s.startswith("https://")))


def app_catalog():
    """The shared shortcut catalog (chat apps / terminal apps / API)."""
    return {"ok": True, "apps": [{"name": n, "url": u, "what": w}
                                 for n, (u, w) in sorted(PHONE_APPS.items())]}


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
        _devices.clear(); _queues.clear(); _events.clear(); _policy.clear()
        _pairing["code"] = None; _pairing["expires"] = 0; _counter["n"] = 0
        return {"ok": True}
