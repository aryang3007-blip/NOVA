#!/usr/bin/env python3
"""
AURA local server.

    python3 serve.py                      # http://localhost:8000
    python3 serve.py 3000                 # custom port
    python3 serve.py --allow-actions      # ENABLE desktop control
    python3 serve.py --allow-actions --allow-lan   # phone on same wifi

Camera, microphone and WebXR require a *secure context*: this server provides
localhost, which browsers trust. Opening index.html via file:// will not work.

--allow-actions turns on the Local Action Bridge, letting AURA open apps
(WhatsApp, Spotify, VS Code…), control media/volume and take screenshots.
It is OFF by default. See server/bridge.py for the full security model.
"""
# Path-safety rule (ONE canonical pattern): make the AURA root importable no
# matter how we are launched — `python server/serve.py`, the legacy root
# shim (`python serve.py`) or `from server import serve`.
import os as _os
import sys as _sys

_AURA_ROOT = _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__)))
if _AURA_ROOT not in _sys.path:
    _sys.path.insert(0, _AURA_ROOT)

import http.server
import socketserver
import json
import os
import platform
import secrets
import sys
import threading
import time
import urllib.request
import urllib.error
import webbrowser
from urllib.parse import urlparse, parse_qs

# ── Windows console encoding ──────────────────────────────────────────────
# Windows defaults its console to cp1252, which cannot encode the box-drawing
# and arrow characters used in AURA's banner and logs. Printing them raised
#     UnicodeEncodeError: 'charmap' codec can't encode characters...
# and the server died before it ever bound a port.
#
# Python 3.7+ lets us re-open the streams as UTF-8. `errors="replace"` is the
# safety net: on a console that still cannot render a glyph we print a "?"
# instead of crashing. ASCII fallbacks are also used for the banner below.
def _force_utf8_stdout():
    for stream in ("stdout", "stderr"):
        s = getattr(sys, stream, None)
        try:
            if s and hasattr(s, "reconfigure"):
                s.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


_force_utf8_stdout()


def _console_supports_unicode():
    """Can this terminal actually render the fancy banner?"""
    enc = (getattr(sys.stdout, "encoding", "") or "").lower()
    if "utf" in enc:
        return True
    try:
        "═→✓".encode(enc or "ascii")
        return True
    except Exception:
        return False


UNICODE_OK = _console_supports_unicode()

# Colour codes break older Windows terminals too; disable when not a TTY.
USE_COLOR = sys.stdout.isatty() and os.environ.get("NO_COLOR") is None
if USE_COLOR and platform.system() == "Windows":
    # Enable ANSI escape processing on Windows 10+ consoles.
    try:
        import ctypes
        k = ctypes.windll.kernel32
        k.SetConsoleMode(k.GetStdHandle(-11), 7)
    except Exception:
        USE_COLOR = False


def c(code, text):
    """Colourise only when the terminal can handle it."""
    return f"\033[{code}m{text}\033[0m" if USE_COLOR else text


def glyph(fancy, plain):
    """Pick a character the console can actually print."""
    return fancy if UNICODE_OK else plain


def say(*parts, **kwargs):
    """print() that can never kill the server on an encoding error."""
    msg = " ".join(str(p) for p in parts)
    try:
        print(msg, **kwargs)
    except UnicodeEncodeError:
        enc = (getattr(sys.stdout, "encoding", "") or "ascii")
        print(msg.encode(enc, "replace").decode(enc, "replace"), **kwargs)


# ── server log gate: /log on|off ─────────────────────────────────────────
# GUI-less users see every HTTP request, action and model swap in their
# terminal. That gets loud fast, so logs are toggleable at runtime.
_CLI_LOGS = True


def _log(*parts, **kwargs):
    """Server log line, suppressed while /log off (banners still print)."""
    if _CLI_LOGS:
        say(*parts, **kwargs)


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ── args ──────────────────────────────────────────────────────────────────
args = sys.argv[1:]
ALLOW_ACTIONS = "--allow-actions" in args
ALLOW_LAN = "--allow-lan" in args
PORT = 8000
for a in args:
    if a.isdigit():
        PORT = int(a)

TOKEN = secrets.token_urlsafe(24)

OLLAMA_BASE = os.environ.get("AURA_OLLAMA", "http://localhost:11434")
for i, a in enumerate(args):
    if a == "--ollama" and i + 1 < len(args):
        OLLAMA_BASE = args[i + 1]

# Optional: real system telemetry. Without psutil the endpoint reports
# unavailable rather than inventing numbers.
try:
    import psutil
except Exception:
    psutil = None

try:
    from server import ollama_proxy
except Exception as e:                     # pragma: no cover
    ollama_proxy = None
    say(f"  !! ollama_proxy.py unavailable: {e}")

# Device gateway (phone companion). Stdlib-only, so this should never fail —
# but AURA must still boot without it rather than dying at import time.
try:
    from server import devices
except Exception as e:                     # pragma: no cover
    devices = None
    say(f"  !! devices.py unavailable: {e}")

try:
    import docbuilder
except Exception:
    docbuilder = None

import time as _t_start
import queue as _queue
_START_TIME = _t_start.time()
_VOICE_EVENT_QUEUE = _queue.Queue()

bridge = None
if ALLOW_ACTIONS:
    try:
        from server import bridge as _bridge
        bridge = _bridge
    except Exception as e:                    # pragma: no cover
        say(f"  !! bridge.py failed to import: {e}")
        ALLOW_ACTIONS = False

# ── Persistence & Database Manager (SQLite + DPAPI Vault) ─────────────────
try:
    from persistence import db_manager, credential_vault
    from persistence.importer import seed_wake_phrases_from_file
    from persistence.api import PersistenceAPIHandler
    _db_init_info = db_manager.initialize()
    seed_wake_phrases_from_file()
except Exception as e:
    _db_init_info = {"ok": False, "error": str(e)}
    say(c(31, f"  !! Persistence subsystem failed to initialize: {e}"))


FAVICON_SVG = b"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <circle cx="50" cy="50" r="44" fill="#04121f" stroke="#22d3ee" stroke-width="4"/>
  <circle cx="50" cy="50" r="28" fill="none" stroke="#3b82f6" stroke-width="3" stroke-dasharray="14 8"/>
  <circle cx="50" cy="50" r="12" fill="#f59e0b"/>
</svg>"""



class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript", ".mjs": "text/javascript",
        ".wasm": "application/wasm", ".json": "application/json",
        ".css": "text/css", ".svg": "image/svg+xml",
        ".task": "application/octet-stream", ".tflite": "application/octet-stream",
    }

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    # ── helpers ───────────────────────────────────────────────────────────
    def _json(self, obj, code=200):
        try:
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            self.close_connection = True

    def _authed(self):
        return self.headers.get("X-AURA-Token") == TOKEN

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        # Required for SharedArrayBuffer (Porcupine wake-word engine uses WASM + Web Workers).
        # These are same-origin only — all AURA resources are served from the same origin,
        # so no cross-site content is blocked by these headers.
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        super().end_headers()

    # ── routes ────────────────────────────────────────────────────────────
    def do_GET(self):
        path = urlparse(self.path).path

        # ── Database & Persistence API
        if path.startswith("/api/db/"):
            q = parse_qs(urlparse(self.path).query)
            try:
                data, code = PersistenceAPIHandler.handle_get(path, q)
                return self._json(data, code)
            except Exception as e:
                return self._json({"ok": False, "message": f"Database error: {e}"}, 500)

        # ── favicon
        if path in ("/favicon.ico", "/favicon.svg", "/favicon.png", "/apple-touch-icon.png", "/apple-touch-icon-precomposed.png"):

            self.send_response(200)
            self.send_header("Content-Type", "image/svg+xml")
            self.send_header("Content-Length", str(len(FAVICON_SVG)))
            self.send_header("Cache-Control", "public, max-age=86400")
            self.end_headers()
            self.wfile.write(FAVICON_SVG)
            return

        # ── /screen — AURA Live, the full screen-control page.
        if path in ("/screen", "/screen/", "/live", "/live/"):
            try:
                with open(os.path.join(ROOT, "live.html"), "rb") as f:
                    body = f.read()
            except Exception as e:
                return self._json({"ok": False, "message": f"live page missing: {e}"}, 404)
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return

        # ── /phone — the Android companion page.
        if path in ("/phone", "/phone/", "/companion"):
            try:
                with open(os.path.join(ROOT, "phone.html"), "rb") as f:
                    body = f.read()
            except Exception as e:
                return self._json({"ok": False, "message": f"phone page missing: {e}"}, 404)
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return

        # ── device gateway: HOST side needs the host token.
        if path == "/api/devices":
            if not self._authed():
                return self._json({"ok": False, "message": "Bad token."}, 401)
            return self._json(devices.status())

        # ── /dev — version + release notes, served as a real page.
        if path in ("/dev", "/dev/"):
            try:
                with open(os.path.join(ROOT, "dev.html"), "rb") as f:
                    body = f.read()
            except Exception as e:
                return self._json({"ok": False, "message": f"dev page missing: {e}"}, 404)
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return

        if path == "/api/version":
            try:
                with open(os.path.join(ROOT, "VERSION.json"), "r", encoding="utf-8") as f:
                    data = json.load(f)
            except Exception as e:
                return self._json({"ok": False, "message": f"VERSION.json unreadable: {e}"}, 500)
            data["ok"] = True
            data["actionsEnabled"] = ALLOW_ACTIONS
            data["os"] = (bridge.SYSTEM if bridge else None)
            if ollama_proxy:
                st = ollama_proxy.status(OLLAMA_BASE, with_capabilities=False)
                data["ollama"] = {"running": st.get("running", False),
                                  "models": st.get("names", [])}
            return self._json(data)

        if path == "/api/status":
            return self._json({
                "ok": True,
                "actionsEnabled": ALLOW_ACTIONS,
                "os": (bridge.SYSTEM if bridge else None),
            })

        # ── /api/health — Consolidated Subsystem Health Check
        if path == "/api/health":
            ollama_st = {"running": False, "models": []}
            if ollama_proxy:
                st = ollama_proxy.status(OLLAMA_BASE, with_capabilities=False)
                ollama_st = {"running": st.get("running", False), "models": st.get("names", [])}

            wake_st = getattr(self.server, "_wake_status", {"status": "ONLINE", "engine": "openWakeWord / Whisper"})
            paired_count = len(devices.PAIRED) if devices else 0
            doc_avail = bool(docbuilder)

            return self._json({
                "ok": True,
                "timestamp": _t_start.time(),
                "uptime": int(_t_start.time() - _START_TIME),
                "services": {
                    "core": {"status": "HEALTHY", "port": PORT, "lan": ALLOW_LAN},
                    "ollama": {"status": "HEALTHY" if ollama_st["running"] else "OFFLINE", **ollama_st},
                    "wake": {"status": wake_st.get("status", "HEALTHY"), **wake_st},
                    "stt": {"status": "READY", "provider": "WebSpeech / Faster-Whisper"},
                    "tts": {"status": "READY", "provider": "WebSpeech / Viseme-Audio"},
                    "vision": {"status": "READY", "multimodal": True},
                    "desktop": {"status": "READY" if ALLOW_ACTIONS else "DISABLED", "actions": ALLOW_ACTIONS, "os": (bridge.SYSTEM if bridge else None)},
                    "search": {"status": "READY", "provider": "DuckDuckGo"},
                    "devices": {"status": "READY", "pairedCount": paired_count},
                    "documents": {"status": "READY" if doc_avail else "PARTIAL", "available": doc_avail}
                }
            })

        # ── /api/voice/status — Voice service status
        if path == "/api/voice/status":
            st = getattr(self.server, "_wake_status", {"status": "READY", "engine": "openWakeWord", "device": "Default"})
            return self._json({"ok": True, "voice": st})

        # ── /api/voice/devices — Audio input devices
        if path == "/api/voice/devices":
            try:
                from voice.wake_service import list_audio_devices
                devs = list_audio_devices()
                return self._json({"ok": True, "devices": devs})
            except Exception as e:
                return self._json({"ok": False, "devices": [], "message": str(e)})

        # ── /api/voice/events — Event stream polling for local Python voice service
        if path == "/api/voice/events":
            try:
                ev = _VOICE_EVENT_QUEUE.get(timeout=10.0)
                return self._json({"ok": True, "event": ev})
            except _queue.Empty:
                return self._json({"ok": True, "event": None})

        # Token handed to the page same-origin. A cross-origin site cannot read
        # this response (no CORS headers), so it cannot steal the token.
        if path == "/api/token":
            if not ALLOW_ACTIONS:
                return self._json({"ok": False, "message": "Actions disabled. Restart with --allow-actions"}, 403)
            return self._json({"ok": True, "token": TOKEN})

        # ── Real system metrics. Browsers cannot read CPU/RAM, so the UI
        #    depends on this endpoint for genuine numbers. If psutil is
        #    missing we say so; we never fabricate a value.
        if path == "/api/metrics":
            if psutil is None:
                return self._json({
                    "ok": False,
                    "psutil": False,
                    "reason": "psutil is not installed on the host. Run: pip install psutil",
                })
            try:
                import time as _t
                vm = psutil.virtual_memory()
                du = psutil.disk_usage("/")
                freq = None
                try:
                    f = psutil.cpu_freq()
                    freq = f.current if f else None
                except Exception:
                    pass

                gpu = {"available": False, "reason": "No GPU telemetry (needs nvidia-smi or vendor tooling)"}
                try:
                    import shutil as _sh
                    import subprocess as _sp
                    if _sh.which("nvidia-smi"):
                        out = _sp.run(
                            ["nvidia-smi",
                             "--query-gpu=utilization.gpu,name,memory.used,memory.total",
                             "--format=csv,noheader,nounits"],
                            capture_output=True, text=True, timeout=3)
                        if out.returncode == 0 and out.stdout.strip():
                            parts = [x.strip() for x in out.stdout.strip().split("\n")[0].split(",")]
                            gpu = {"available": True, "percent": float(parts[0]), "name": parts[1],
                                   "memUsed": float(parts[2]), "memTotal": float(parts[3])}
                except Exception:
                    pass

                return self._json({
                    "ok": True,
                    "psutil": True,
                    # interval=None returns load since the previous call — non-blocking.
                    "cpu": {"percent": psutil.cpu_percent(interval=None),
                            "cores": psutil.cpu_count(logical=True),
                            "freq": freq},
                    "memory": {"percent": vm.percent, "used": vm.used, "total": vm.total},
                    "disk": {"percent": du.percent, "free": du.free, "total": du.total},
                    "gpu": gpu,
                    "processes": len(psutil.pids()),
                    "uptime": _t.time() - psutil.boot_time(),
                    "platform": platform.system(),
                    "release": platform.release(),
                })
            except Exception as e:
                return self._json({"ok": False, "psutil": True, "reason": f"Metrics failed: {e}"})

        # ── Generic fetch proxy for sources that lack CORS (RSS news feeds).
        #    Allowlisted hosts only — this must never become an open proxy.
        if path == "/api/fetch":
            q = parse_qs(urlparse(self.path).query)
            target = (q.get("url") or [""])[0]
            as_text = (q.get("as") or ["json"])[0] == "text"
            allowed_hosts = (
                "feeds.bbci.co.uk", "rss.cnn.com", "feeds.reuters.com",
                "news.google.com", "feeds.npr.org", "www.theguardian.com",
                "hnrss.org", "techcrunch.com", "feeds.arstechnica.com",
            )
            try:
                from urllib.parse import urlparse as _up
                h = _up(target).hostname or ""
                if not target.startswith("https://") or h not in allowed_hosts:
                    return self._json({"ok": False, "message": f"Host '{h}' is not in the fetch allowlist."}, 403)
                req = urllib.request.Request(target, headers={"User-Agent": "AURA/1.0"})
                with urllib.request.urlopen(req, timeout=12) as r:
                    body = r.read()
                self.send_response(200)
                self.send_header("Content-Type", "text/xml; charset=utf-8" if as_text else "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)
                return
            except Exception as e:
                return self._json({"ok": False, "message": f"Fetch failed: {e}"}, 502)

        # ── Ollama (proxied so the browser never hits a cross-origin wall)
        if path == "/api/ollama/status":
            if not ollama_proxy:
                return self._json({"ok": False, "running": False, "reason": "proxy module missing"})
            return self._json(ollama_proxy.status(OLLAMA_BASE))

        if path == "/api/ollama/catalog":
            if not ollama_proxy:
                return self._json({"ok": False, "models": []})
            return self._json(ollama_proxy.catalog(OLLAMA_BASE))

        if path == "/api/apps":
            if not ALLOW_ACTIONS:
                return self._json({"ok": False, "message": "Actions disabled."}, 403)
            if not self._authed():
                return self._json({"ok": False, "message": "Bad token."}, 401)
            return self._json({"ok": True, "apps": bridge.list_apps(), "os": bridge.SYSTEM})

        return super().do_GET()

    def _read_body(self, limit=1 << 20):
        n = int(self.headers.get("Content-Length", 0))
        if n > limit:
            return None
        return self.rfile.read(n) if n else b""

    def _stream_ollama(self, path, body, note=None):
        """Pipe Ollama's streaming response straight to the browser."""
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")
        if note:
            # Tell the UI we substituted a model, so it can say so out loud
            # instead of silently answering as a different model.
            self.send_header("X-AURA-Model-Note", note.replace("\n", " ")[:200])
        self.end_headers()

        broken = {"v": False}

        def write(chunk):
            if broken["v"]:
                return
            try:
                self.wfile.write(chunk)
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                broken["v"] = True     # client hit Stop — expected

        code, err = ollama_proxy.proxy_stream(OLLAMA_BASE, path, "POST", body, write)
        if err and not broken["v"]:
            try:
                self.wfile.write(json.dumps({"error": err}).encode() + b"\n")
                self.wfile.flush()
            except Exception:
                pass

    def do_POST(self):
        path = urlparse(self.path).path

        # ── Database & Persistence API (POST)
        if path.startswith("/api/db/"):
            body = self._read_body(limit=5 << 20)
            try:
                p = json.loads(body or b"{}")
            except Exception:
                p = {}
            try:
                data, code = PersistenceAPIHandler.handle_post(path, p)
                return self._json(data, code)
            except Exception as e:
                return self._json({"ok": False, "message": f"Database error: {e}"}, 500)

        # ── /api/voice/status (POST) — Telemetry from Python voice service
        if path == "/api/voice/status":

            body = self._read_body()
            try:
                p = json.loads(body or b"{}")
                setattr(self.server, "_wake_status", p)
                return self._json({"ok": True})
            except Exception:
                return self._json({"ok": False}, 400)

        # ── /api/voice/wake — Endpoint for Python wake_service.py
        if path == "/api/voice/wake":
            body = self._read_body()
            if body is None:
                return self._json({"ok": False, "message": "Payload too large"}, 413)
            try:
                payload = json.loads(body or b"{}")
            except Exception:
                return self._json({"ok": False, "message": "Bad JSON"}, 400)

            p_type = payload.get("type", "wake_detected")
            phrase = payload.get("phrase", "Hey Nova")
            score = float(payload.get("score", 1.0))
            source = payload.get("source", "openwakeword")
            ts = float(payload.get("timestamp", _t_start.time()))

            # Debounce protection (ignore duplicate wake events within 1.2s)
            last_ts = getattr(self.server, "_last_wake_ts", 0.0)
            if ts - last_ts < 1.2:
                return self._json({"ok": True, "message": "Debounced"})
            setattr(self.server, "_last_wake_ts", ts)

            ev = {
                "type": p_type,
                "phrase": phrase,
                "score": score,
                "source": source,
                "timestamp": ts,
                "transcript": payload.get("transcript", ""),
                "command": payload.get("command", "")
            }
            _VOICE_EVENT_QUEUE.put(ev)
            _log(c(32, f"  🎙 WAKE EVENT RECEIVED: {phrase} (score: {score:.2f}, source: {source})"))
            return self._json({"ok": True, "message": "Wake event queued"})

        # ── device gateway ────────────────────────────────────────────────
        #
        # Two classes of route, deliberately separated:
        #   /api/device/*  COMPANION. Authenticated by the DEVICE token that
        #                  pairing issued. A phone can only receive actions
        #                  and report status - there is no route here that
        #                  runs anything on Windows.
        #   /api/devices/* HOST. Requires the host token, same as every other
        #                  privileged endpoint.
        if path.startswith("/api/device/"):
            body = self._read_body()
            if body is None:
                return self._json({"ok": False, "message": "Payload too large"}, 413)
            try:
                p = json.loads(body or b"{}")
            except Exception:
                return self._json({"ok": False, "message": "Bad JSON"}, 400)
            sub = path[len("/api/device/"):]

            # Pairing is the ONLY unauthenticated route, and it needs the
            # 6-digit code the laptop is displaying.
            if sub == "pair":
                r = devices.pair(p.get("code"), p.get("name"),
                                 p.get("platform", "android"), p.get("capabilities"),
                                 kind=p.get("kind"))
                return self._json(r, 200 if r.get("ok") else 403)

            did, tok = p.get("deviceId"), p.get("token")
            if sub == "heartbeat":
                r = devices.heartbeat(did, tok, p.get("info"))
            elif sub == "poll":
                r = devices.poll(did, tok, float(p.get("wait", 20)))
            elif sub == "ack":
                r = devices.acknowledge(did, tok, p.get("actionId"),
                                        p.get("success", True), p.get("detail", ""))
            else:
                return self._json({"ok": False, "message": f"Unknown device route '{sub}'"}, 404)
            return self._json(r, r.get("code", 200) if not r.get("ok") else 200)

        if path.startswith("/api/devices/"):
            if not self._authed():
                return self._json({"ok": False, "message": "Bad token."}, 401)
            body = self._read_body()
            try:
                p = json.loads(body or b"{}")
            except Exception:
                p = {}
            sub = path[len("/api/devices/"):]
            if sub == "pair-start":
                # QR + URL are attached inside devices.start_pairing(), so the
                # bridge action path gets them too.
                return self._json(devices.start_pairing(PORT))
            if sub == "pair-cancel":
                return self._json(devices.cancel_pairing())
            if sub == "unpair":
                return self._json(devices.unpair(p.get("deviceId")))
            if sub == "send":
                return self._json(devices.send_action(p.get("device"), p.get("action"),
                                                      p.get("params")))
            return self._json({"ok": False, "message": f"Unknown devices route '{sub}'"}, 404)

        # ── Ollama proxy: same-origin, so zero CORS configuration needed.
        if path.startswith("/api/ollama/"):
            if not ollama_proxy:
                return self._json({"ok": False, "message": "Ollama proxy unavailable"}, 503)
            body = self._read_body()
            if body is None:
                return self._json({"ok": False, "message": "Payload too large"}, 413)
            sub = path[len("/api/ollama/"):]
            allowed = {"chat": "/api/chat", "generate": "/api/generate",
                       "pull": "/api/pull", "show": "/api/show",
                       "embeddings": "/api/embeddings"}
            if sub not in allowed:
                return self._json({"ok": False, "message": f"Unknown ollama route '{sub}'"}, 404)

            # ── LAST LINE OF DEFENCE against a wrong model name.
            # If anything upstream still asks for a model that isn't pulled,
            # snap it to a real one instead of letting Ollama 404. The client
            # is told what happened via the x-aura-model-note header.
            note = None
            if sub in ("chat", "generate"):
                try:
                    payload = json.loads(body or b"{}")
                    want = payload.get("model") or ""
                    real, note = ollama_proxy.resolve_model(want, OLLAMA_BASE)
                    if real and real != want:
                        payload["model"] = real
                        body = json.dumps(payload).encode()
                        _log(c(33, f"  {glyph(chr(0x21bb), '~')} model '{want}' -> '{real}'"))
                    elif real is None:
                        return self._json({"ok": False, "error":
                            "No Ollama models installed. Run:  ollama pull gemma2:2b"}, 503)
                except Exception:
                    pass
            if sub == "pull":
                try:
                    model = json.loads(body or b"{}").get("model", "")
                except Exception:
                    model = ""
                _log(c(36, f"  {glyph(chr(0x2b07), 'v')} pulling model: {model}"))
            return self._stream_ollama(allowed[sub], body, note=note)

        if path != "/api/action":
            return self._json({"ok": False, "message": "Not found"}, 404)
        if not ALLOW_ACTIONS:
            return self._json({"ok": False, "message":
                               "Desktop actions are disabled. Restart AURA with: python3 serve.py --allow-actions"}, 403)
        if not self._authed():
            return self._json({"ok": False, "message": "Invalid or missing token."}, 401)

        try:
            n = int(self.headers.get("Content-Length", 0))
            # write_file legitimately carries file content, so 8 KB was too
            # small. bridge.write_file enforces its own 2 MB content cap.
            if n > 3 * 1024 * 1024:
                return self._json({"ok": False, "message": "Payload too large."}, 413)
            payload = json.loads(self.rfile.read(n) or b"{}")
        except Exception as e:
            return self._json({"ok": False, "message": f"Bad JSON: {e}"}, 400)

        action = str(payload.get("action", ""))[:40]
        params = payload.get("params") or {}
        if not isinstance(params, dict):
            return self._json({"ok": False, "message": "params must be an object."}, 400)

        try:
            result = bridge.dispatch(action, params)
        except Exception as e:
            result = {"ok": False, "message": f"Action error: {e}"}

        icon = c(32, glyph("✓", "OK")) if result.get("ok") else c(31, glyph("✗", "XX"))
        detail = params.get("app") or params.get("url") or params.get("query") or params.get("action") or ""
        _log(f"  {icon} ACTION {action} {detail} -> {result.get('message', '')}")
        return self._json(result)

    def do_DELETE(self):
        path = urlparse(self.path).path
        if path.startswith("/api/db/"):
            q = parse_qs(urlparse(self.path).query)
            body = self._read_body()
            try:
                p = json.loads(body or b"{}")
            except Exception:
                p = {}
            try:
                data, code = PersistenceAPIHandler.handle_delete(path, q, p)
                return self._json(data, code)
            except Exception as e:
                return self._json({"ok": False, "message": f"Database error: {e}"}, 500)
        return self._json({"ok": False, "message": "Not found"}, 404)

    def do_OPTIONS(self):

        # No CORS allow-origin on purpose → cross-site preflight fails.
        self.send_response(204)
        self.end_headers()

    def log_message(self, fmt, *a):
        msg = fmt % a
        if "favicon" in msg or "apple-touch-icon" in msg:
            return
        if " 404 " in msg or " 500 " in msg:
            _log(c(31, msg))


class ThreadedHTTPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    """
    One thread per request.
    """
    daemon_threads = True
    allow_reuse_address = True
    def handle_error(self, request, client_address):
        import traceback
        exc = sys.exc_info()[1]
        if isinstance(exc, (BrokenPipeError, ConnectionResetError,
                            ConnectionAbortedError, TimeoutError)):
            return
        traceback.print_exc()


import re as _re

_ANSI_RE = _re.compile(r'\x1b\[[0-9;]*m')
_CLI_MODEL = ""

def _visible_len(text):
    s = _ANSI_RE.sub('', text)
    width = 0
    for char in s:
        code = ord(char)
        if (0x1F300 <= code <= 0x1F9FF) or code in (0x26a1, 0x2713, 0x25c7):
            width += 2
        else:
            width += 1
    return width

def _pad_left(text, width):
    v = _visible_len(text)
    return (" " * max(0, width - v)) + text

def _pad_right(text, width):
    v = _visible_len(text)
    return text + (" " * max(0, width - v))

def _pad_center(text, width):
    v = _visible_len(text)
    pad = max(0, width - v)
    l = pad // 2
    r = pad - l
    return (" " * l) + text + (" " * r)

def _get_uptime_str():
    elapsed = int(_t_start.time() - _START_TIME)
    hours = elapsed // 3600
    minutes = (elapsed % 3600) // 60
    seconds = elapsed % 60
    return f"{hours}h {minutes:02d}m {seconds:02d}s"

def _get_cli_model_info():
    global _CLI_MODEL
    if _CLI_API_PROVIDER:
        meta = CLI_API_PROVIDERS.get(_CLI_API_PROVIDER, {})
        model_name = _CLI_API_MODEL or meta.get("default_model", "?")
        return model_name, f"(via {meta.get('label', _CLI_API_PROVIDER)})"
    model_name = "gemma2:2b"
    params_str = "(2B parameters)"
    if ollama_proxy:
        st = ollama_proxy.status(OLLAMA_BASE)
        if st.get("running") and st.get("models"):
            names = st.get("names", [])
            chat_models = [m for m in st["models"] if "embedding" not in (m.get("caps") or [])]
            if _CLI_MODEL and _CLI_MODEL in names:
                model_name = _CLI_MODEL
                match_m = next((m for m in st["models"] if m.get("name") == model_name), None)
                if match_m and match_m.get("params"):
                    params_str = f"({match_m['params']} parameters)"
            elif chat_models:
                m = chat_models[0]
                model_name = m.get("name", "gemma2:2b")
                if m.get("params"):
                    params_str = f"({m['params']} parameters)"
            elif names:
                model_name = names[0]
    return model_name, params_str

def _get_lan_address():
    if ALLOW_LAN:
        import socket
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("8.8.8.8", 80))
            ip = s.getsockname()[0]
            s.close()
            return f"http://{ip}:{PORT}/"
        except Exception:
            return f"http://127.0.0.1:{PORT}/"
    return f"http://127.0.0.1:{PORT}/"

def _render_cli_banner():
    model_name, params_str = _get_cli_model_info()
    lan_url = _get_lan_address()
    uptime = _get_uptime_str()

    cyan = lambda t: c(36, t)
    green = lambda t: c(32, t)
    magenta = lambda t: c(35, t)
    yellow = lambda t: c(33, t)
    white = lambda t: c(37, t)
    dim = lambda t: c(90, t)
    bold = lambda t: c(1, t)

    w = 94
    inner_w = w - 2

    g_net = glyph("🌐", "[NET]")
    g_bolt = glyph("⚡", "[AI]")
    g_brain = glyph("🧠", "[SYS]")
    g_clock = glyph("⏰", "[TIME]")
    g_disk = glyph("💾", "[MEM]")
    g_check = glyph("✓", "[OK]")

    l1_left = f" {g_net} {cyan('LAN EXPOSED ')} : {white(lan_url)}"
    l1_right = f" {green(g_check)} {cyan('ACTIONS ENABLED ')} : {green('Yes') if ALLOW_ACTIONS else c(31, 'No')}"

    l2_left = f" {g_bolt} {cyan('MODEL PINNED ')} : {green(model_name)}"
    l2_right = f" {green(g_check)} {cyan('LAN ACCESS      ')} : {green('Allowed') if ALLOW_LAN else dim('Localhost only')}"

    l3_left = f" {g_brain} {cyan('STATUS       ')} : {green('ONLINE')}"
    l3_right = f" {green(g_check)} {cyan('DOCUMENTS       ')} : {green('Available')}"

    l4_left = f" {g_clock} {cyan('UPTIME       ')} : {white(uptime)}"
    l4_right = f" {green(g_check)} {cyan('TOOLS           ')} : {green('Active')}"

    l5_left = f" {g_disk} {cyan('CONTEXT      ')} : {white(f'{model_name} {params_str}')}"
    l5_right = ""

    top_title = f" {bold(cyan('AURA CLI'))} "
    title_len = _visible_len(" AURA CLI ")
    pad_title_l = (inner_w - title_len) // 2
    pad_title_r = inner_w - title_len - pad_title_l
    top_line = cyan("┌" + ("─" * pad_title_l) + top_title + ("─" * pad_title_r) + "┐")
    bottom_line = cyan("└" + ("─" * inner_w) + "┘")

    def make_box_row(left_str, right_str, col1_w=48, col2_w=44):
        left_padded = _pad_right(left_str, col1_w)
        right_padded = _pad_right(right_str, col2_w)
        return cyan("│") + left_padded + right_padded + cyan("│")

    r1 = make_box_row(l1_left, l1_right)
    r2 = make_box_row(l2_left, l2_right)
    r3 = make_box_row(l3_left, l3_right)
    r4 = make_box_row(l4_left, l4_right)
    r5 = make_box_row(l5_left, l5_right)

    box1 = "\n".join([top_line, r1, r2, r3, r4, r5, bottom_line])

    cmd_title = f" {cyan(bold('AVAILABLE COMMANDS'))} "
    cmd_title_len = _visible_len(" AVAILABLE COMMANDS ")
    pad_cmd_l = (w - cmd_title_len) // 2
    pad_cmd_r = w - cmd_title_len - pad_cmd_l
    cmd_header_line = cyan("─" * pad_cmd_l) + cmd_title + cyan("─" * pad_cmd_r)

    cmds = [
        ("/help", "Show help"),
        ("/model", "Switch backend"),
        ("/doc", "Doc capabilities"),
        ("/log", "Toggle logs"),
        ("/policy", "Action policy"),
        ("/clear", "Clear chat"),
        ("/exit", "Exit CLI")
    ]
    col_widths = [15, 15, 15, 15, 15, 14, 14]

    row_cmds_parts = []
    row_descs_parts = []

    for i, (cmd_name, cmd_desc) in enumerate(cmds):
        cw = col_widths[i]
        c_str = cyan(bold(_pad_center(cmd_name, cw)))
        d_str = white(_pad_center(cmd_desc, cw))
        row_cmds_parts.append(c_str)
        row_descs_parts.append(d_str)

    sep = cyan("│")
    row_cmds_line = sep.join(row_cmds_parts)
    row_descs_line = sep.join(row_descs_parts)

    cmd_box = "\n".join([cmd_header_line, row_cmds_line, row_descs_line])

    chat_title_text = f" CHAT WITH AURA ({model_name}) "
    chat_title_len = _visible_len(chat_title_text)
    pad_chat_l = (w - chat_title_len) // 2
    pad_chat_r = w - chat_title_len - pad_chat_l
    chat_header_line = magenta("─" * pad_chat_l) + magenta(bold(chat_title_text)) + magenta("─" * pad_chat_r)

    say(box1)
    say("")
    say(cmd_box)
    say("")
    say(chat_header_line)
    say("")


def _cli_banner():
    _render_cli_banner()


# ════════════════════════════════════════════════════════════════════════
# CLI API-provider mode  (Sept-01 batch)
# ────────────────────────────────────────────────────────────────────────
# The REPL used to be Ollama-only. Now the terminal can talk to the same
# cloud providers as the web UI, using the same encrypted credential vault
# (~/.aura) — no pasting keys into the terminal.
#
#   /model          interactive picker: [1..5] API providers, [6] Ollama
#   /model gemini   pin API provider (+ optional :model name)
#   /doc ppt on X   REAL model outline (API provider or Ollama) with an
#                   honestly-labelled offline-template fallback + reason
#   /log on|off     gate server logs in the terminal
# ════════════════════════════════════════════════════════════════════════

_CLI_API_PROVIDER = ""        # '' = Ollama mode; else e.g. 'gemini'
_CLI_API_MODEL = ""           # '' = provider default
_CLI_VAT = None               # {provider: key} loaded from the vault once

CLI_API_PROVIDERS = {
    "gemini": {"label": "Google Gemini", "default_model": "gemini-2.0-flash",
               "kind": "gemini"},
    "openai": {"label": "OpenAI", "default_model": "gpt-4o-mini", "kind": "openai"},
    "groq": {"label": "Groq", "default_model": "llama-3.3-70b-versatile", "kind": "openai"},
    "openrouter": {"label": "OpenRouter",
                   "default_model": "meta-llama/llama-3.3-70b-instruct", "kind": "openai"},
    "anthropic": {"label": "Anthropic",
                  "default_model": "claude-3-5-haiku-20241022", "kind": "anthropic"},
}
# Order shown in the picker = the documented escalation order.
CLI_API_ORDER = ["gemini", "openrouter", "openai", "groq", "anthropic"]


def _cli_vault_key(provider: str) -> str:
    """Key for `provider` from the encrypted vault (default profile first)."""
    global _CLI_VAT
    if _CLI_VAT is None:
        _CLI_VAT = {}
        try:
            names = credential_vault.profile_names() or ["default"]
            for prof in names:
                k = credential_vault.get_key(provider, prof)
                if k:
                    _CLI_VAT[provider] = k
                    break
        except Exception as e:
            say(c(31, f"  [vault unavailable: {e}]"))
    if provider not in _CLI_VAT:
        try:
            k = credential_vault.get_key(provider) or None
            if k:
                _CLI_VAT[provider] = k
        except Exception:
            pass
    return _CLI_VAT.get(provider, "")


def _cli_vault_profiles():
    try:
        return credential_vault.profile_names()
    except Exception:
        return []


def _cli_menu_entries():
    """The /model picker rows (pure — unit-testable)."""
    entries = []
    for pid in CLI_API_ORDER:
        meta = CLI_API_PROVIDERS[pid]
        entries.append({
            "kind": "api", "id": pid, "label": meta["label"],
            "model": meta["default_model"],
            "has_key": bool(_cli_vault_key(pid)),
        })
    entries.append({"kind": "ollama", "id": "ollama",
                    "label": "Ollama (local models)", "model": "", "has_key": True})
    entries.append({"kind": "ollama", "id": "ollama-auto",
                    "label": "Ollama — auto (first installed)", "model": "", "has_key": True})
    return entries


def _cli_pick_entry(entries, choice):
    """1-based pick → entry, or None (pure)."""
    try:
        n = int(choice)
    except (TypeError, ValueError):
        return None
    return entries[n - 1] if 1 <= n <= len(entries) else None


def _cli_model_menu():
    """Interactive /model picker: [1..5] API providers, [6] Ollama, [7] auto."""
    entries = _cli_menu_entries()
    say("\n" + c(36, "── CLI MODEL PICKER ────────────────────────────────────────────"))
    say(f"  {c(37, 'API PROVIDERS')}")
    for i, e in enumerate(entries[:5], 1):
        keymark = c(32, "✓ key") if e["has_key"] else c(31, "no key")
        say(f"  [{i}] {c(36, e['label']):<22} {e['model']:<26} {keymark}")
    for i, e in enumerate(entries[5:], 6):
        say(f"  [{i}] {c(36, e['label'])}")
    say(f"  {c(37, 'Tip:')} /model gemini, /model gemini:gemini-2.5-flash, /model <ollama-model>")
    try:
        choice = input("  Select 1-7 (Enter to cancel): ").strip()
    except (EOFError, KeyboardInterrupt):
        return
    if not choice:
        return
    e = _cli_pick_entry(entries, choice)
    if not e:
        say(c(31, f"  '{choice}' is not a valid pick."))
        return
    if e["kind"] == "api":
        if not e["has_key"]:
            say(c(31, f"  {e['label']} has no key in the vault — add one in Settings or set it in the vault."))
            return
        _cli_set_api(e["id"], "")
        say(c(32, f"  ◈ CLI now chats via {e['label']} ({e['model']})"))
    elif e["id"] == "ollama-auto":
        _cli_set_api("", "")
        _CLI_MODEL = ""
        say(c(32, "  CLI back to Ollama auto."))
    else:
        _cli_set_api("", "")
        say(c(37, "  Ollama installed models: run /model list, or type /model <name>"))


def _cli_set_api(provider: str, model: str = ""):
    global _CLI_API_PROVIDER, _CLI_API_MODEL
    _CLI_API_PROVIDER = provider
    _CLI_API_MODEL = model


def _cli_show_ollama_models(arg=""):
    """List installed Ollama models (the pre-API view, kept for familiarity)."""
    if not ollama_proxy:
        say(c(31, "  Ollama proxy module unavailable."))
        return
    st = ollama_proxy.status(OLLAMA_BASE)
    if not st.get("running"):
        say(c(31, "  Ollama not running — cannot list models."))
        say(c(33, "  Fix: run  ollama serve  in another terminal"))
        return
    models = st.get("models", [])
    if not models:
        say(c(33, "  No models installed. Run: ollama pull gemma2:2b"))
        return
    say("\n" + c(36, "  Installed Ollama models:"))
    for i, m in enumerate(models):
        name = m.get("name", "?")
        params = m.get("params") or "?"
        size = m.get("size_gb") or 0
        marker = c(32, " ◄ active") if name == _CLI_MODEL else (c(37, " [auto]") if i == 0 and not _CLI_MODEL else "")
        say(f"  [{i+1}] {c(36, name)}  {params}  {size:.1f}G{marker}")
    say(f"\n  {c(37, 'Tip:')} /model <name> to pin, /model auto to reset")


def _cli_pin_ollama(arg):
    """Pin the CLI to a specific installed Ollama model."""
    global _CLI_MODEL
    if not ollama_proxy:
        say(c(31, "  Ollama proxy module unavailable."))
        return
    st = ollama_proxy.status(OLLAMA_BASE)
    if not st.get("running"):
        say(c(31, "  Ollama not running — cannot select a model."))
        return
    names = st.get("names", [])
    match = next((n for n in names if n == arg), None)
    if not match:
        match = next((n for n in names if n.lower().startswith(arg.lower())), None)
    if not match:
        match = next((n for n in names if arg.lower() in n.lower()), None)
    if match:
        _cli_set_api("", "")
        _CLI_MODEL = match
        say(c(32, f"  ◈ Pinned CLI to: {match}"))
        say(c(37, "  Type any message to chat with this model"))
    else:
        say(c(31, f"  Model '{arg}' not found."))
        say(c(33, f"  Installed: {', '.join(names) or 'none'}"))
        say(c(37, "  Run /model to open the picker, or /model list for Ollama models"))


def _cli_active_backend():
    """What the REPL is using right now, in words (for banner + /doc)."""
    if _CLI_API_PROVIDER:
        meta = CLI_API_PROVIDERS[_CLI_API_PROVIDER]
        model = _CLI_API_MODEL or meta["default_model"]
        return {"mode": "api", "provider": _CLI_API_PROVIDER, "label": meta["label"],
                "model": model}
    model_name, _ = _get_cli_model_info()
    return {"mode": "ollama", "provider": "ollama", "label": "Ollama (local)",
            "model": model_name}


def _cli_docgen_backend(kind):
    """Effective backend for /doc: the preconfigured pin when its key exists,
    otherwise whatever the terminal is on (honest label either way)."""
    pp, pm = _cli_docgen_pin(kind)
    if pp and _cli_vault_key(pp):
        meta = CLI_API_PROVIDERS.get(pp, {"label": pp})
        return {"mode": "api", "provider": pp, "label": meta["label"],
                "model": pm, "pin": True}
    return _cli_active_backend()


def _cli_resolve_path(target, must_exist=True):
    """
    Safe path resolver for CLI /doc when the action bridge is off.
    Same jail rule as bridge._resolve_path: home folder and below only.
    """
    raw = str(target or "").strip().strip('"').strip("'")
    if not raw:
        return None, "No path given."
    raw = os.path.expandvars(os.path.expanduser(raw))
    if not os.path.isabs(raw):
        raw = os.path.join(os.path.expanduser("~"), raw)
    p = os.path.realpath(raw)
    home = os.path.realpath(os.path.expanduser("~"))
    if not (p == home or p.startswith(home + os.sep)):
        return None, f"Refused: '{target}' is outside your home folder."
    if must_exist and not os.path.exists(p):
        return None, f"Not found: {p}"
    return p, None


def _cli_api_url(provider_id):
    """Endpoint for an OpenAI-compatible provider (pure)."""
    return {
        "openai": "https://api.openai.com/v1/chat/completions",
        "groq": "https://api.groq.com/openai/v1/chat/completions",
        "openrouter": "https://openrouter.ai/api/v1/chat/completions",
    }.get(provider_id, "")


def _cli_api_request(provider_id, key, messages, model, stream, max_tokens, temperature):
    """Build (payload, headers, url) for one provider. Pure — unit-testable."""
    meta = CLI_API_PROVIDERS[provider_id]
    kind = meta.get("kind", "openai")
    system = "\n\n".join(m["content"] for m in messages if m.get("role") == "system")
    convo = [m for m in messages if m.get("role") != "system"]
    if kind == "gemini":
        contents = [{"role": "model" if m["role"] == "assistant" else "user",
                     "parts": [{"text": m["content"]}]} for m in convo]
        base = "https://generativelanguage.googleapis.com/v1beta/models"
        if stream:
            url = f"{base}/{model}:streamGenerateContent?alt=sse&key={key}"
        else:
            url = f"{base}/{model}:generateContent?key={key}"
        # thinkingBudget 0: Gemini 2.5 models count THINKING tokens inside
        # maxOutputTokens. A deck outline is mechanical JSON — with thinking
        # on, the budget is eaten before the object closes and /doc reports
        # "JSON TRUNCATED mid-stream". Disable it so the whole cap is output.
        payload = {"contents": contents, "generationConfig": {
            "temperature": temperature, "maxOutputTokens": max_tokens,
            "thinkingConfig": {"thinkingBudget": 0}}}
        if system:
            payload["systemInstruction"] = {"parts": [{"text": system}]}
        return payload, {"Content-Type": "application/json"}, url
    if kind == "anthropic":
        payload = {"model": model, "messages": convo, "max_tokens": max_tokens,
                   "temperature": temperature, "stream": stream}
        if system:
            payload["system"] = system
        return (payload,
                {"Content-Type": "application/json", "x-api-key": key,
                 "anthropic-version": "2023-06-01"},
                "https://api.anthropic.com/v1/messages")
    payload = {"model": model, "messages": messages, "stream": stream,
               "max_tokens": max_tokens, "temperature": temperature}
    return (payload,
            {"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
            _cli_api_url(provider_id))


def _cli_parse_sse_delta(data: str, kind: str):
    """One SSE `data:` payload → visible text delta, or None. Pure."""
    if not data or data == "[DONE]":
        return None
    try:
        evt = json.loads(data)
    except Exception:
        return None
    if kind == "gemini":
        parts = ((evt.get("candidates") or [{}])[0].get("content") or {}).get("parts") or []
        return "".join(p.get("text", "") for p in parts) or None
    if kind == "anthropic":
        if evt.get("type") == "content_block_delta":
            return (evt.get("delta") or {}).get("text")
        return None
    delta = ((evt.get("choices") or [{}])[0].get("delta") or {})
    return delta.get("content")


def _cli_api_response_text(kind: str, body: str):
    """Non-stream body → plain text. Pure."""
    try:
        evt = json.loads(body or "{}")
    except Exception:
        return ""
    if kind == "gemini":
        parts = ((evt.get("candidates") or [{}])[0].get("content") or {}).get("parts") or []
        return "".join(p.get("text", "") for p in parts)
    if kind == "anthropic":
        return "".join(b.get("text", "") for b in (evt.get("content") or [])
                       if isinstance(b, dict))
    return (evt.get("choices") or [{}])[0].get("message", {}).get("content", "")


def _cli_sse_lines(resp, buffer_size=2048):
    """Yield SSE lines from a response object. Test seam-friendly."""
    buf = ""
    while True:
        chunk = resp.read(buffer_size)
        if not chunk:
            break
        if isinstance(chunk, bytes):
            chunk = chunk.decode("utf-8", "replace")
        buf += chunk
        lines = buf.split("\n")
        buf = lines.pop()
        for line in lines:
            yield line.strip()
    if buf.strip():
        yield buf.strip()


def _cli_api_stream(provider_id, messages, on_delta, max_tokens=2048, urlopen_fn=None):
    """Stream a chat from an API provider. Returns (code, error_or_None)."""
    meta = CLI_API_PROVIDERS.get(provider_id)
    if not meta:
        return 404, f"Unknown CLI provider '{provider_id}'."
    key = _cli_vault_key(provider_id)
    if not key:
        return 403, (f"No {meta['label']} key in the vault. "
                     "Add it in AURA Settings → AI Core, then restart the server.")
    allowed, info = _cli_budget_ok("chat")
    if not allowed:
        msg = (f"daily request budget reached ({info.get('used', 0)}/"
               f"{info.get('cap', 0)}) — nothing was sent. Raise it in "
               f"Settings → Keys & Spend, or wait until tomorrow.")
        _cli_usage_log(provider_id, _CLI_API_MODEL or meta["default_model"],
                       "chat", "blocked", msg)
        return 429, msg
    model = _CLI_API_MODEL or meta["default_model"]
    payload, headers, url = _cli_api_request(provider_id, key, messages, model, True,
                                             max_tokens, 0.7)
    try:
        opener = urlopen_fn or urllib.request.urlopen
        req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"),
                                     method="POST", headers=headers)
        with opener(req, timeout=300) as r:
            for line in _cli_sse_lines(r):
                if not line.startswith("data:"):
                    continue
                delta = _cli_parse_sse_delta(line[5:].strip(), meta["kind"])
                if delta:
                    on_delta(delta)
        _cli_usage_log(provider_id, model, "chat", "ok")
        return 200, None
    except urllib.error.HTTPError as e:
        msg = f"HTTP {e.code}: {_cli_clip(e.read().decode('utf-8', 'replace'))}"
        _cli_usage_log(provider_id, model, "chat", "error", msg)
        return e.code, msg
    except Exception as e:
        msg = f"{meta['label']} request failed: {_cli_clip(e)}"
        _cli_usage_log(provider_id, model, "chat", "error", msg)
        return 503, msg


def _cli_usage_log(provider, model, kind, status, detail=""):
    """Spend ledger — fire-and-forget, never breaks generation."""
    try:
        from persistence.repositories import usage_repo
        usage_repo.record(provider or "?", model or "", kind=kind,
                          status=status, detail=str(detail or "")[:200])
    except Exception:
        pass


def _cli_budget_ok(kind="chat"):
    """(allowed, info) — daily cap checked BEFORE the wire (0 = unlimited)."""
    try:
        from persistence.repositories import usage_repo
        return usage_repo.check(kind)
    except Exception:
        return True, {}


def _cli_clip(text, n=140):
    """Provider error bodies are raw JSON — one short readable line."""
    s = " ".join(str(text or "").split()).replace("\\n", " ").replace('"', "'")
    return s[:n] + ("…" if len(s) > n else "")


def _cli_complete_json(messages, max_tokens=4096, timeout=300, urlopen_fn=None,
                       provider=None, model=None, retries=2, retry_delay=2.0):
    """
    One non-streaming completion, decoded to JSON.
    `provider`/`model` are the per-call DOCGEN PIN (the preconfigured outline
    model) — they override the chat backend for document generation, exactly
    like the app. Returns (obj|None, note); note is '' on success, else the
    TRUE cause.
    429/503 (quota / high demand — exactly the user's logs) are retried with
    backoff before giving up, and every attempt lands in the usage ledger.
    """
    provider = provider or _CLI_API_PROVIDER
    if provider:
        meta = CLI_API_PROVIDERS[provider]
        key = _cli_vault_key(provider)
        if not key:
            return None, f"No {meta['label']} key in the vault."
        allowed, info = _cli_budget_ok("outline")
        if not allowed:
            msg = (f"daily request budget reached ({info.get('used', 0)}/"
                   f"{info.get('cap', 0)}) — the outline was NOT sent. Raise it "
                   f"in Settings → Keys & Spend, or wait until tomorrow.")
            _cli_usage_log(provider, model or _CLI_API_MODEL,
                           "outline", "blocked", msg)
            return None, msg
        model = model or _CLI_API_MODEL or meta["default_model"]
        payload, headers, url = _cli_api_request(provider, key, messages,
                                                 model, False, max_tokens, 0.45)
        attempts = 1 + max(0, int(retries))
        last_err = ""
        for attempt in range(attempts):
            try:
                opener = urlopen_fn or urllib.request.urlopen
                req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"),
                                             method="POST", headers=headers)
                with opener(req, timeout=timeout) as r:
                    body = r.read().decode("utf-8", "replace")
                _cli_usage_log(provider, model, "outline", "ok",
                               f"{meta['label']} · {len(body)} bytes")
                text = _cli_api_response_text(meta["kind"], body)
                return _cli_extract_json(text)
            except urllib.error.HTTPError as e:
                msg = (f"{meta['label']} HTTP {e.code}: "
                       f"{_cli_clip(e.read().decode('utf-8', 'replace'))}")
                last_err = msg
                if e.code in (429, 503) and attempt < attempts - 1:
                    time.sleep(retry_delay * (attempt + 1))
                    _cli_usage_log(provider, model, "outline", "retried", msg)
                    continue
                _cli_usage_log(provider, model, "outline", "error", msg)
                return None, msg
            except Exception as e:
                last_err = f"{meta['label']} request failed: {_cli_clip(e)}"
                _cli_usage_log(provider, model, "outline", "error", last_err)
                return None, last_err
        return None, last_err or f"{meta['label']} request failed"
    return _cli_ollama_complete(messages, max_tokens)


def _cli_ollama_complete(messages, max_tokens=4096):
    """Ollama non-streaming completion → (obj|None, note)."""
    if not ollama_proxy:
        return None, "Ollama proxy module missing."
    st = ollama_proxy.status(OLLAMA_BASE)
    if not st.get("running"):
        return None, f"Ollama offline: {st.get('reason', 'not reachable')}"
    chat_models = [m["name"] for m in st.get("models", [])
                   if "embedding" not in (m.get("caps") or [])]
    names = st.get("names", [])
    if not chat_models and not names:
        return None, "No Ollama models installed. Run: ollama pull gemma2:2b"
    model = _CLI_MODEL if (_CLI_MODEL in names) else (chat_models or names)[0]
    payload = {"model": model, "messages": messages, "stream": False,
               "options": {"num_predict": max_tokens, "temperature": 0.45}}
    chunks = []
    code, err = ollama_proxy.proxy_stream(
        OLLAMA_BASE, "/api/chat", "POST", json.dumps(payload).encode(),
        lambda b: chunks.append(b))
    if err:
        return None, f"Ollama error {code}: {err}"
    raw = b"".join(chunks).decode("utf-8", "replace")
    text = ""
    for line in raw.splitlines():
        try:
            evt = json.loads(line)
        except Exception:
            continue
        if isinstance(evt, dict) and evt.get("message", {}).get("content"):
            text = evt["message"]["content"]
    if not text:
        return None, f"Ollama empty answer ({len(raw)} bytes)."
    return _cli_extract_json(text)


def _cli_extract_json(text):
    """
    Lenient JSON extraction (fence strip, balanced-brace scan).
    Returns (obj|None, note); note is '' on success, else a TRUE cause —
    never the generic 'no usable JSON'.
    """
    s = str(text or "").strip()
    if not s:
        return None, "The model returned an empty response."
    s = _re.sub(r"^```(?:json)?\s*|\s*```$", "", s.strip(), flags=_re.I).strip()
    try:
        return json.loads(s), ""
    except Exception:
        pass
    start = s.find("{")
    if start < 0:
        return None, f"The model replied with prose, not JSON (first 60: {s[:60]!r})."
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(s)):
        ch = s[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                cand = s[start:i + 1]
                try:
                    return json.loads(cand), ""
                except Exception:
                    return None, (f"The JSON was malformed: {cand[:80]!r}… "
                                  "(repaired extractor could not parse it)")
    return None, (f"The JSON was TRUNCATED mid-stream — got {len(s)} chars, "
                  f"the object never closes. Usually the model hit its output cap; "
                  f"a shorter deck or larger num_predict fixes it.")


def _cli_doc_kind(arg):
    """Parse '/doc <kind> on|of|about <topic>' → (kind, topic, slides, audience, details)."""
    low = arg.lower().strip()
    kind = "docx"
    if any(w in low for w in ("ppt", "powerpoint", "slides", "presentation", "deck")):
        kind = "pptx"
    elif any(w in low for w in ("sheet", "excel", "xlsx", "spreadsheet", "workbook")):
        kind = "xlsx"
    elif any(w in low for w in ("report", "doc", "docx", "word", "essay")):
        kind = "docx"

    # details: "with: ..." / "must include ..." — extracted FIRST
    details = ""
    m = _re.search(r",?\s*(?:with|including)\s*:\s*([^.!?\n]+)$", arg, _re.I) \
        or _re.search(r"\bmust\s+include\s+([^.!?\n]+)$", arg, _re.I)
    if m:
        details = m.group(1).strip()
        arg = arg[:m.start()].rstrip(" ,;:")
        arg = _re.sub(r"\b(that|which|and|with)\s*$", "", arg, flags=_re.I).rstrip()

    # audience: "for class 10 [students]" at the END
    audience = ""
    am = _re.search(r"\bfor\s+((?:class\s*\d+|students?|beginners?|kids|investors?|"
                    r"executives?|college|school|teachers?|professionals?|experts?|"
                    r"audience)[^,.]*)$", arg, _re.I)
    if am:
        audience = am.group(1).strip()
        arg = arg[:am.start()].rstrip(" ,;:")

    # topic: everything after on/about/for/of, else text minus the kind word
    sep = _re.search(r"\b(?:on|about|for|regarding|covering|of)\s+(.+)$", arg, _re.I)
    if sep:
        topic = sep.group(1).strip()
    else:
        topic = _re.sub(
            r"^(?:make|create|build|generate|write|prepare|draft|a|an|the|please|"
            r"\d+\s*(?:slide|slides|page|pages)?\s*)", "", arg, flags=_re.I)
        topic = _re.sub(r"\b(?:ppt|pptx|powerpoint|slides|presentation|deck|sheet|excel|"
                        r"xlsx|spreadsheet|report|doc|docx|word|essay)\s*", "", topic,
                        flags=_re.I).strip()
        topic = _re.sub(r"^(?:on|about|for|of|regarding|covering)\s*", "", topic,
                        flags=_re.I).strip()
    topic = _re.sub(r"[.!?]+$", "", topic).strip() or "Analysis"

    slides = 0
    sm = _re.search(r"(\d{1,2})\s*[- ]\s*(?:slides?|pages?)", arg, _re.I)
    if sm:
        slides = min(30, max(3, int(sm.group(1))))
    return kind, topic, slides, audience, details


def _cli_offline_spec(kind, topic):
    """The honest offline template (same content as the old hardcoded specs)."""
    import datetime

    today_str = datetime.date.today().strftime('%d %B %Y')
    if kind == "pptx":
        return {
            "title": topic.title(),
            "subtitle": f"AURA Intelligence Briefing · {today_str}",
            "slides": [
                {"title": f"Overview of {topic.title()}",
                 "bullets": [f"Key contextual factors and drivers for {topic}",
                             "Current landscape, observations, and modern trends",
                             "Strategic scope and objectives"]},
                {"title": "Key Dynamics & Assessment",
                 "bullets": ["Primary findings and data indicators",
                             "Risk vectors, challenge areas, and critical bottlenecks",
                             "Comparative impact across operational areas"]},
                {"title": "Strategic Recommendations",
                 "bullets": ["High-priority action items for stakeholders",
                             "Policy frameworks, standards, and practical methods",
                             "Resource allocation and timeline milestones"]},
                {"title": "Summary & Next Steps",
                 "bullets": ["Core takeaways synthesized",
                             "Future outlook and progressive roadmap",
                             "Action items and ongoing measurement"]},
            ],
        }
    if kind == "xlsx":
        return {
            "title": f"{topic.title()} Summary",
            "sheets": [{
                "name": "Summary",
                "columns": ["Item / Metric", "Category", "Baseline", "Target", "Status", "Notes"],
                "rows": [
                    [f"{topic.title()} - Primary Factor", "Strategic", 100, 150, "Active", "On schedule"],
                    [f"{topic.title()} - Operational Metric", "Core", 85, 95, "Review", "Quarterly evaluation"],
                    [f"{topic.title()} - Performance Target", "Growth", 210, 280, "Active", "High priority"],
                    ["Summary Total", "Aggregate", 395, 525, "On Track", "Baseline tracking"],
                ],
            }],
        }
    return {
        "title": f"Report: {topic.title()}",
        "subtitle": f"AURA Comprehensive Analysis · {today_str}",
        "sections": [
            {"heading": "Executive Summary", "level": 1,
             "paragraphs": [f"This report provides an in-depth, structured evaluation of {topic}. "
                            "It outlines the primary background, current operational and situational "
                            "landscape, and strategic recommendations for stakeholders."],
             "bullets": [f"Clear synthesis of current {topic} developments",
                         "Evaluation of critical risk vectors and opportunities"]},
            {"heading": "Context & Background", "level": 1,
             "paragraphs": [f"Understanding {topic} requires examining both historical precedents "
                            "and recent shifts in the operational environment."]},
            {"heading": "Analysis & Findings", "level": 1,
             "paragraphs": [f"Analysis indicates multiple intersecting dynamics across {topic}."],
             "bullets": ["Primary finding 1: Core trend identification and impact",
                         "Primary finding 2: Strategic dependencies and vulnerability areas",
                         "Primary finding 3: Resource allocation and implementation factors"]},
            {"heading": "Recommendations & Next Steps", "level": 1,
             "paragraphs": [f"To effectively navigate challenges surrounding {topic}, structured "
                            "milestones and continuous assessment must be prioritized."],
             "bullets": ["Immediate action items (30-60 days)",
                         "Medium-term strategic initiatives",
                         "Long-term governance and review process"]},
        ],
    }


def _cli_build_options(kind, arg=""):
    """Parse `/doc ppt on X --theme holiday --transition push --animation bounce
    --images 2 --style '3d render' --speed slow` into build-service options.
    Pure and unit-tested; defaults mirror the manifest."""
    opts = {"theme": "", "transition": "fade", "speed": "med", "animation": "none",
            "images": {"enabled": False, "count": 1, "style": "flat illustration",
                       "provider": "gemini"}}
    if kind != "pptx":
        return opts
    a = str(arg or "")
    m = _re.search(r"--theme\s+([a-z0-9-]+)", a, _re.I)
    if m:
        opts["theme"] = m.group(1)
    m = _re.search(r"--transition\s+([a-z0-9-]+)", a, _re.I)
    if m:
        opts["transition"] = m.group(1)
    m = _re.search(r"--speed\s+(fast|med|slow)", a, _re.I)
    if m:
        opts["speed"] = m.group(1)
    m = _re.search(r"--animation\s+([a-z0-9-]+)", a, _re.I)
    if m:
        opts["animation"] = m.group(1)
    m = _re.search(r"--images(?:\s+([1-3]))?", a, _re.I)
    if m:
        opts["images"]["enabled"] = True
        if m.group(1):
            opts["images"]["count"] = int(m.group(1))
    m = _re.search(r"--style\s+(.+?)(?=\s+--|\s*$)", a, _re.I)
    if m:
        opts["images"]["style"] = m.group(1).strip().strip('"\'')
    m = _re.search(r"--provider\s+(gemini|openai)", a, _re.I)
    if m:
        opts["images"]["provider"] = m.group(1)
    return opts


def _cli_ask_choice(prompt, options, default_idx=None, input_fn=None):
    """Numbered option question, same style as the /model picker:
       '1' → options[0]; Enter → default. input_fn is the test seam.
       Returns the chosen INDEX, default_idx on Enter, None on cancel/EOF."""
    inp = input_fn or input
    say(f"  ? {prompt}")
    for i, opt in enumerate(options, 1):
        mark = "  (default)" if default_idx is not None and i - 1 == default_idx else ""
        say(f"    [{i}] {opt}{mark}")
    default_label = str((default_idx or 0) + 1) if default_idx is not None else "—"
    while True:
        try:
            raw = inp(f"  Choose 1-{len(options)} (Enter={default_label}): ").strip()
        except (EOFError, KeyboardInterrupt):
            return None
        if not raw:
            return default_idx
        if _cli_pick_entry(options, raw) is not None:
            return options.index(_cli_pick_entry(options, raw))
        say(c(31, f"  '{raw}' is not a valid pick — enter 1-{len(options)} or press Enter."))


def _cli_ask_number(prompt, lo, hi, default, input_fn=None):
    """Plain number question with a safe default (Enter = default)."""
    inp = input_fn or input
    while True:
        try:
            raw = inp(f"  ? {prompt} (Enter={default}): ").strip()
        except (EOFError, KeyboardInterrupt):
            return None
        if not raw:
            return default
        try:
            n = int(raw)
        except ValueError:
            say(c(31, f"  '{raw}' is not a number."))
            continue
        if lo <= n <= hi:
            return n
        say(c(31, f"  '{n}' is out of range — {lo}-{hi}."))


def _cli_doc_wizard(kind, slides=0, input_fn=None):
    """
    Interactive /doc questions (the popup, in terminal form — same knobs,
    same manifest defaults, same canonical options):
      pptx → design, slide count, AI images (count/style/provider), motion
      docx/xlsx → section/sheet count
    Returns (options_dict, slides) or None when cancelled.
    input_fn is the test seam; the real terminal uses input().
    """
    try:
        from services import registry as _reg
        from services.docgen import images as _img
    except Exception:
        _reg = None
        _img = None

    inp = input_fn or input
    say(c(36, "\n  ── /doc OPTIONS (Enter = default) ──────────────────────────────"))
    opts = {"theme": "", "transition": "fade", "speed": "med", "animation": "none",
            "images": {"enabled": False, "count": 1, "style": "flat illustration",
                       "provider": "gemini"}}
    if kind != "pptx":
        default_n = 6 if kind == "docx" else 1
        n = _cli_ask_number(f"{kind.upper()} sections/sheets", 1, 40,
                            slides or default_n, input_fn=inp)
        if n is None:
            return None
        return opts, n

    # ── design ──
    themes = list(_reg.themes()) if _reg else ["professional-dark"]
    d = 0
    try:
        d = themes.index("professional-dark")
    except ValueError:
        pass
    pick = _cli_ask_choice("What design?", themes, default_idx=d, input_fn=inp)
    if pick is None:
        return None
    opts["theme"] = themes[pick]

    # ── length ──
    n = _cli_ask_number("How many slides?", 3, 30, slides or 10, input_fn=inp)
    if n is None:
        return None

    # ── AI images ──
    img_yes = _cli_ask_choice("Generate AI images (embedded on visual slides)?",
                              ["yes", "no"], default_idx=0, input_fn=inp)
    if img_yes is None:
        return None
    if img_yes == 0:
        cnt = _cli_ask_number("How many images?", 1, 3, 1, input_fn=inp)
        if cnt is None:
            return None
        styles = list(_img.STYLE_HINTS.keys()) if _img else ["flat illustration"]
        style_i = _cli_ask_choice("Image style?", styles, default_idx=0, input_fn=inp)
        if style_i is None:
            return None
        provs = [p["id"] for p in (_reg.image_providers() if _reg else [])] or ["gemini", "openai"]
        prov_i = _cli_ask_choice("Image provider?", provs, default_idx=0, input_fn=inp)
        if prov_i is None:
            return None
        provider_id = provs[prov_i]
        img_opts = {"enabled": True, "count": cnt, "style": styles[style_i],
                    "provider": provider_id}
        # Same choice as the popup: when the provider ships >1 model, ask
        # which one — so the exact model that will run is never a surprise.
        prov_meta = {}
        try:
            if _reg:
                prov_meta = next((p for p in _reg.image_providers()
                                  if p["id"] == provider_id), {})
        except Exception:
            prov_meta = {}
        model_opts = prov_meta.get("models") or []
        if len(model_opts) > 1:
            m_i = _cli_ask_choice("Image model?", [m["id"] for m in model_opts],
                                  default_idx=0, input_fn=inp)
            if m_i is None:
                return None
            img_opts["model"] = model_opts[m_i]["id"]
        opts["images"] = img_opts

    # ── motion (like PowerPoint's ease: transition + entrance) ──
    trans = list(_reg.transitions()) if _reg else ["fade"]
    t_i = _cli_ask_choice("Slide transition?", trans,
                          default_idx=trans.index("fade") if "fade" in trans else 0, input_fn=inp)
    if t_i is None:
        return None
    opts["transition"] = trans[t_i]
    s_i = _cli_ask_choice("Transition speed?", ["fast", "med", "slow"], default_idx=1, input_fn=inp)
    if s_i is None:
        return None
    opts["speed"] = ["fast", "med", "slow"][s_i]
    anims = list(_reg.animations()) if _reg else ["none"]
    a_i = _cli_ask_choice("Entrance animation?", anims,
                          default_idx=anims.index("none") if "none" in anims else 0, input_fn=inp)
    if a_i is None:
        return None
    opts["animation"] = anims[a_i]
    return opts, n


def _cli_merge_build_options(base, wizard):
    """Wizard answers win over the flag-parsed defaults (flags still parse
    when the terminal is piped/non-interactive). Images merge by field."""
    out = dict(base or {})
    w = wizard or {}
    out["theme"] = w.get("theme") or out.get("theme") or ""
    if w.get("transition"):
        out["transition"] = w["transition"]
    if w.get("speed"):
        out["speed"] = w["speed"]
    if w.get("animation"):
        out["animation"] = w["animation"]
    if w.get("images", {}).get("enabled"):
        out["images"] = {**out.get("images", {}), **w["images"]}
    return out


def _cli_describe_options(opts, kind, slides=0):
    """One-line confirmation of the choices (the terminal equivalent of the
    popup's selected knobs)."""
    if kind != "pptx":
        say(f"  {c(37, 'Choices:')} {slides or 0} segment(s) · defaults for the rest")
        return
    img = opts.get("images") or {}
    parts = []
    if opts.get("theme"):
        parts.append(f"design: {opts['theme']}")
    if slides:
        parts.append(f"{slides} slides")
    parts.append(f"transition: {opts.get('transition', 'fade')} ({opts.get('speed', 'med')})")
    parts.append(f"animation: {opts.get('animation', 'none')}")
    if img.get("enabled"):
        parts.append(f"images: {img.get('count')} ({img.get('style')}, "
                     f"{img.get('provider')}"
                     + (f" → {img.get('model')}" if img.get("model") else "")
                     + ")")
    say(f"  {c(37, 'You chose:')} " + " · ".join(parts))


def _cli_docgen_pin(kind):
    """
    ONE preconfigured outline model (user's decision): document generation
    asks THE model — gemini-3.8-flash (newest stable, writes text + json +
    image prompts) — no matter what chat backend the terminal is on.
    Reads the model id from the MANIFEST (services/manifest.json), so the
    terminal, app and tests cannot drift. Returns (provider, model) or
    (None, None) when the manifest has no pin.
    """
    if kind != "pptx":
        return None, None
    try:
        from services import registry as _reg
        model = _reg.defaults("pptx").get("model") or ""
    except Exception:
        model = ""
    return ("gemini", model) if model else (None, None)


def _cli_doc_spec(kind, topic, slides=0, audience="", details="", complete_fn=None):
    """
    Ask a model for a real outline. Document generation uses the
    preconfigured pin (_cli_docgen_pin) when its key exists; otherwise the
    active chat backend runs and the honest note says so.
    Returns (spec|None, note); note is '' on success, else the honest cause.
    `complete_fn` is a test seam for _cli_complete_json.
    """
    # Shared prompt + validation with the app's python service — ONE language
    # for the model, ONE rule for the outline, whatever calls it.
    try:
        from services.docgen import outline as _o
        SCHEMAS_P, RULES_P = _o.SCHEMAS, _o.RULES
    except Exception:
        SCHEMAS_P, RULES_P = {}, {}
    schemas = SCHEMAS_P or {
        "pptx": '{"title":"…","slides":[]}',
        "xlsx": '{"title":"…","sheets":[]}',
        "docx": '{"title":"…","sections":[]}',
    }
    rules = RULES_P.get(kind, "")
    sys_p = (f"You are a world-class document designer. Reply with ONE JSON object and nothing "
             f"else — no prose, no markdown fences.\n\nShape: {schemas[kind]}\n\nRules: {rules}\n"
             + (f"The user asked for {slides} slides.\n" if slides else "")
             + (f"Audience: {audience}.\n" if audience else ""))
    usr = f"Topic: {topic}\n" + (f"Extra instructions: {details}\n" if details else "") + "Produce the JSON now."
    messages = [{"role": "system", "content": sys_p}, {"role": "user", "content": usr}]
    max_tokens = 8192 if kind == "pptx" else 4096
    # Docgen pin: the preconfigured outline model leads; test seams skip it.
    pin_provider, pin_model = _cli_docgen_pin(kind)
    use_pin = bool(pin_provider and complete_fn is None and _cli_vault_key(pin_provider))
    if use_pin:
        _cli_doc_spec_pin = {"provider": pin_provider, "model": pin_model}
    else:
        _cli_doc_spec_pin = {}
    call = lambda msgs, **kw: (complete_fn or _cli_complete_json)(
        msgs, **{**_cli_doc_spec_pin, **kw})
    obj, note = call(messages, max_tokens=max_tokens)
    if note:
        # One bounded retry when the outline was cut off: TIGHTER deck AND
        # DOUBLE the output budget (same model first — a real deck beats the
        # offline template; backend escalation stays the last resort).
        if "TRUNCATED" in note or "prose" in note.lower() or "empty" in note.lower():
            tight_sys = sys_p.replace(
                "8-12 content slides", "6-9 content slides").replace(
                "(8-18 words)", "(6-12 words)")
            tight_sys += ("\nCRITICAL: fit the ENTIRE JSON in one reply. If space runs low, "
                          "prefer fewer slides and shorter bullets over an incomplete object. "
                          "Speaker notes: one short sentence only.")
            obj, note2 = call(
                [{"role": "system", "content": tight_sys}, {"role": "user", "content": usr}],
                max_tokens=min(65536, max_tokens * 2))
            if obj:
                return obj, ""
            note = f"{note} (retried with a tighter deck and a larger budget: {note2})"
        return None, note
    if not isinstance(obj, dict):
        return None, "The model returned JSON that was not an object."
    if kind == "pptx" and not (isinstance(obj.get("slides"), list) and obj["slides"]):
        return None, "The model outline had no slides."
    if kind == "xlsx" and not (isinstance(obj.get("sheets"), list) and obj["sheets"]):
        return None, "The model outline had no sheets."
    if kind == "docx" and not (isinstance(obj.get("sections"), list) and obj["sections"]):
        return None, "The model outline had no sections."
    return obj, ""


def _cli_chat(text):
    global _CLI_MODEL
    messages = [
        {"role": "system", "content": "You are AURA, a concise AI assistant in a terminal CLI. Keep answers short and direct. Use plain text, avoid markdown except for code blocks."},
        {"role": "user", "content": text},
    ]

    if _CLI_API_PROVIDER:
        meta = CLI_API_PROVIDERS[_CLI_API_PROVIDER]
        model = _CLI_API_MODEL or meta["default_model"]
        diamond = glyph("◇", "*")
        who = meta["label"]
        sys.stdout.write(f"\n{c(35, f'{diamond} AURA ({who}: {model})')}  ")
        sys.stdout.flush()

        def on_api_delta(delta):
            sys.stdout.write(delta)
            sys.stdout.flush()

        code, err = _cli_api_stream(_CLI_API_PROVIDER, messages, on_api_delta)
        sys.stdout.write("\n\n")
        sys.stdout.flush()
        if err:
            say(c(31, f"  [Chat error {code}: {err}]"))
        return

    if not ollama_proxy:
        say(c(31, "  [AI offline: Ollama proxy module missing]"))
        return
    st = ollama_proxy.status(OLLAMA_BASE)
    if not st.get("running"):
        reason = st.get("reason", "Ollama not reachable")
        say(c(31, f"  [Ollama offline: {reason}]"))
        say(c(33, "  Tip: run 'ollama serve' in another terminal, then try again."))
        return
    if not st.get("models"):
        say(c(31, "  [No models installed. Run: ollama pull gemma2:2b]"))
        return

    chat_models = [m["name"] for m in st["models"] if "embedding" not in (m.get("caps") or [])]
    if _CLI_MODEL and _CLI_MODEL in (st.get("names") or []):
        model = _CLI_MODEL
    else:
        model = (chat_models or [st["models"][0]["name"]])[0]

    diamond = glyph("◇", "*")
    sys.stdout.write(f"\n{c(35, f'{diamond} AURA ({model})')}  ")
    sys.stdout.flush()

    payload = {
        "model": model,
        "messages": messages,
        "stream": True,
        "options": {"num_predict": 2048},   # same truncation fix as the web UI
    }

    def on_chunk(chunk_bytes):
        try:
            for sub in chunk_bytes.decode("utf-8", errors="ignore").split("\n"):
                if not sub.strip():
                    continue
                data = json.loads(sub)
                msg = data.get("message", {}).get("content", "")
                if msg:
                    sys.stdout.write(msg)
                    sys.stdout.flush()
        except Exception:
            pass

    code, err = ollama_proxy.proxy_stream(
        OLLAMA_BASE, "/api/chat", "POST",
        json.dumps(payload).encode(), on_chunk
    )
    sys.stdout.write("\n\n")
    sys.stdout.flush()
    if err:
        say(c(31, f"  [Chat error {code}: {err}]"))


def _terminal_repl_loop():
    global _CLI_MODEL
    import time
    time.sleep(0.5)
    while True:
        try:
            model_name, _ = _get_cli_model_info()
            bolt = glyph("⚡", ">")
            if USE_COLOR:
                prompt_str = f"{c(33, f'{bolt} AURA:{model_name}')} > "
            else:
                prompt_str = f"AURA:{model_name} > "
            
            user_input = input(prompt_str).strip()
            if not user_input:
                continue
            
            if user_input.startswith("/"):
                parts = user_input.split(maxsplit=1)
                cmd = parts[0].lower()
                arg = parts[1].strip() if len(parts) > 1 else ""
                
                if cmd in ("/help", "/h"):
                    say("\n" + c(36, "── AVAILABLE CLI COMMANDS ──────────────────────────────────────────"))
                    say(f"  {c(33, '/help')}                Show this help message")
                    say(f"  {c(33, '/model')}               Picker: API providers + Ollama models")
                    say(f"  {c(33, '/model gemini[:model]')}  Pin CLI to an API provider")
                    say(f"  {c(33, '/model <ollama-name>')} Pin CLI to a local model")
                    say(f"  {c(33, '/doc')}                 Check document generator capabilities")
                    say(f"  {c(33, '/log on|off')}          Toggle server logs in this terminal")
                    say(f"  {c(33, '/policy')}              View Action Bridge security policy")
                    say(f"  {c(33, '/status')}              System telemetry (CPU, RAM, backend)")
                    say(f"  {c(33, '/apps')}                List detected local desktop applications")
                    say(f"  {c(33, '/open <app|url>')}    Launch desktop app or website")
                    say(f"  {c(33, '/clear')}               Clear screen & refresh dashboard")
                    say(f"  {c(33, '/exit')} / {c(33, '/quit')}       Shut down AURA server\n")
                elif cmd in ("/doc",):
                    if not arg:
                        has_pptx = docbuilder.HAS_PPTX if (docbuilder and hasattr(docbuilder, 'HAS_PPTX')) else False
                        has_xlsx = docbuilder.HAS_XLSX if (docbuilder and hasattr(docbuilder, 'HAS_XLSX')) else False
                        has_docx = docbuilder.HAS_DOCX if (docbuilder and hasattr(docbuilder, 'HAS_DOCX')) else False
                        say("\n" + c(36, "── AURA DOCUMENT GENERATION ────────────────────────────────────"))
                        say(f"  PowerPoint (.pptx):  {c(32, '✓ AVAILABLE') if has_pptx else c(31, '✗ Missing python-pptx (pip install python-pptx)')}")
                        say(f"  Excel (.xlsx):       {c(32, '✓ AVAILABLE') if has_xlsx else c(31, '✗ Missing openpyxl (pip install openpyxl)')}")
                        say(f"  Word (.docx):        {c(32, '✓ AVAILABLE') if has_docx else c(31, '✗ Missing python-docx (pip install python-docx)')}")
                        say(f"\n  {c(37, 'Usage:')} /doc ppt on <topic>")
                        say(f"         /doc sheet of <topic>")
                        say(f"         /doc report on <topic>\n")
                    else:
                        if not docbuilder:
                            say(c(31, "  [Document builder module is not available]"))
                            continue
                        low = arg.lower().strip()
                        kind = "docx"
                        if any(w in low for w in ("ppt", "powerpoint", "slides", "presentation")):
                            kind = "pptx"
                        elif any(w in low for w in ("sheet", "excel", "xlsx", "spreadsheet", "workbook")):
                            kind = "xlsx"
                        elif any(w in low for w in ("report", "doc", "docx", "word", "essay")):
                            kind = "docx"

                        kind, topic, slides, audience, details = _cli_doc_kind(arg)

                        caps = docbuilder.capabilities()
                        if not caps.get(kind):
                            say(c(31, f"\n  ✗ {kind.upper()} generation needs a Python library: {caps.get('install', {}).get(kind, 'pip install')}\n"))
                            continue

                        # ── INTERACTIVE OPTIONS (same knobs as the app popup,
                        #    asked as numbered questions like the /model picker).
                        #    Skipped when stdin is piped, so scripts/tests and
                        #    the live preview server never block.
                        wizard_opts = None
                        if sys.stdin.isatty():
                            _w = _cli_doc_wizard(kind, slides)
                            if _w is None:
                                say(c(31, "\n  /doc cancelled.\n"))
                                continue
                            wizard_opts, slides = _w

                        say(f"\n  {c(33, '⚡ Generating')} {kind.upper()} for: {c(36, topic)}...")
                        backend = _cli_docgen_backend(kind)
                        say(f"  {c(37, 'Backend:')} {backend['label']} ({backend['model']})"
                            + ("  · preconfigured for documents" if backend.get("pin") else ""))
                        if wizard_opts:
                            _cli_describe_options(_cli_merge_build_options(
                                _cli_build_options(kind, arg), wizard_opts), kind, slides)

                        # REAL MODEL OUTLINE via the active backend; honest
                        # offline-template fallback with the TRUE reason.
                        spec, note = _cli_doc_spec(kind, topic, slides, audience, details)
                        spec_source = None
                        if spec is not None:
                            spec_source = f"{backend['label']} ({backend['model']})"
                            say(f"  {c(32, '✓ Model outline received')} from {spec_source}")
                        else:
                            spec = _cli_offline_spec(kind, topic)
                            say(f"  {c(33, '⚠ Model outline failed:')} {note}")
                            say(c(33, "  → using the OFFLINE TEMPLATE (structure only, no model content)"))

                        if spec_source:
                            say(f"  {c(37, 'Outline:')} {spec_source}"
                                + (f" · {slides} slides requested" if slides else "")
                                + (f" · audience: {audience}" if audience else "")
                                + (f" · notes: {details}" if details else ""))
                        else:
                            say(c(37, "  Outline: offline template — no model ran."))
                        # ── CANONICAL BUILD: same services.docgen.service the
                        #    app bridge calls. Feature knobs come from the
                        #    wizard answers (interactive) or flags:
                        #    --theme holiday --transition push --animation bounce
                        #    --images 2 --style "3d render"
                        build_opts = _cli_build_options(kind, arg)
                        if wizard_opts:
                            build_opts = _cli_merge_build_options(build_opts, wizard_opts)
                        try:
                            from services.docgen import service as _ds
                            res = _ds.generate(kind, spec,
                                               folder=docbuilder.default_folder(),
                                               resolver=(bridge._resolve_path
                                                         if bridge else _cli_resolve_path),
                                               options=build_opts)
                        except Exception as e:
                            res = {"ok": False, "message": f"docgen service: {e}"}
                        if res.get("ok"):
                            kb = round(res.get('bytes', 0) / 1024, 1)
                            line = f"  {c(32, '✓ CREATED:')} {res.get('path')} ({kb} KB)"
                            if res.get("images", {}).get("count"):
                                line += f"  · {res['images']['count']} AI image(s)"
                            m = res.get("motion") or {}
                            if m.get("transitions", {}).get("applied"):
                                line += f"  · {m['transitions']['applied']} transitions ({m['transitions']['style']})"
                            if m.get("animation", {}).get("applied"):
                                line += f"  · entrance: {m['animation']['effect']}"
                            say(line + "\n")
                            if res.get("images", {}).get("failed"):
                                say(f"  {c(33, '⚠')} " + "; ".join(res["images"]["failed"]) + "\n")
                        else:
                            say(f"  {c(31, '✗ FAILED:')} {res.get('message', 'Unknown error')}\n")
                elif cmd in ("/policy",):
                    say("\n" + c(36, "── AURA ACTION SECURITY POLICY ────────────────────────────────"))
                    say(f"  Desktop Actions:     {c(32, '✓ ENABLED (--allow-actions)') if ALLOW_ACTIONS else c(31, '✗ DISABLED (Pass --allow-actions)')}")
                    say(f"  LAN Access:          {c(32, '✓ ALLOWED (--allow-lan)') if ALLOW_LAN else c(37, 'LOCAL ONLY (127.0.0.1)')}")
                    say(f"  Confirmation Mode:   {c(32, 'ARM & PREVIEW REQUIRED')} for destructive actions")
                    say(f"  API Token:           {c(32, 'ACTIVE & PROTECTED')}")
                    say(f"  Bridge Capabilities: App Launcher, Screenshots, Volume/Media, Window Control\n")
                elif cmd in ("/status", "/sys"):
                    say("\n" + c(36, "── AURA SYSTEM TELEMETRY ────────────────────────────────"))
                    say(f"  Host OS:        {platform.system()} {platform.release()}")
                    say(f"  Python:         {sys.version.split()[0]}")
                    say(f"  Server:         http://localhost:{PORT}/")
                    say(f"  Actions Bridge: {c(32, 'ENABLED') if ALLOW_ACTIONS else c(31, 'DISABLED')}")
                    say(f"  LAN Mode:       {c(32, 'ENABLED') if ALLOW_LAN else c(37, 'Localhost only')}")
                    if psutil:
                        vm = psutil.virtual_memory()
                        disk = psutil.disk_usage('/')
                        say(f"  CPU:            {psutil.cpu_percent(interval=0.1):.1f}% ({psutil.cpu_count(logical=True)} threads)")
                        say(f"  RAM:            {vm.percent:.1f}%  {round(vm.used/1e9,1)}/{round(vm.total/1e9,1)} GB")
                        say(f"  Disk:           {disk.percent:.1f}%  {round(disk.free/1e9,1)} GB free")
                    else:
                        say(c(33, "  (Install psutil for CPU/RAM: pip install psutil)"))
                    if ollama_proxy:
                        st = ollama_proxy.status(OLLAMA_BASE)
                        if st.get("running"):
                            models = st.get("models", [])
                            m_info = ", ".join([f"{m.get('name')}({m.get('params') or '?'})" for m in models[:5]])
                            if len(models) > 5: m_info += "..."
                            say(f"  Ollama:         {c(32, f'Running — {len(models)} model(s)')}")
                            say(f"  Models:         {m_info}")
                        else:
                            say(f"  Ollama:         {c(31, 'Not running')}")
                    say("")
                elif cmd in ("/apps",):
                    if not ALLOW_ACTIONS or not bridge:
                        say(c(31, "  Desktop actions disabled. Restart server with --allow-actions"))
                    else:
                        apps = bridge.list_apps()
                        say("\n" + c(36, f"── DETECTED APPS ({len(apps)}) ──────────────────────────────────"))
                        for a in apps[:20]:
                            say(f"  • {c(32, a.get('name'))} -> {a.get('exe') or a.get('action')}")
                        if len(apps) > 20:
                            say(f"  ...and {len(apps) - 20} more.")
                        say("")
                elif cmd in ("/open",):
                    if not arg:
                        say(c(31, "  Usage: /open <app_name_or_url>  (e.g., /open spotify)"))
                    elif not ALLOW_ACTIONS or not bridge:
                        say(c(31, "  Desktop actions disabled. Restart server with --allow-actions"))
                    else:
                        say(c(33, f"  Executing launch request: {arg}"))
                        res = bridge.dispatch("open_app", {"app": arg}) if not arg.startswith("http") else bridge.dispatch("open_url", {"url": arg})
                        say(f"  Result: {c(32 if res.get('ok') else 31, res.get('message', ''))}")
                elif cmd in ("/ollama",):
                    if not ollama_proxy:
                        say(c(31, "  Ollama proxy module unavailable."))
                    else:
                        st = ollama_proxy.status(OLLAMA_BASE)
                        if st.get("running"):
                            models = st.get("models", [])
                            say(c(32, f"\n  Ollama  {OLLAMA_BASE}  ({len(models)} model{'s' if len(models)!=1 else ''})"))
                            say(f"  {'MODEL':<34} {'PARAMS':<10} {'SIZE':>6}  CAPS")
                            say("  " + "-" * 65)
                            for m in models:
                                name   = m.get("name", "?")
                                params = m.get("params") or "?"
                                size   = m.get("size_gb") or 0
                                caps   = ",".join(m.get("caps") or []) or "-"
                                active = " ◄" if name == _CLI_MODEL else ""
                                say(f"  {c(36, name):<43} {params:<10} {size:>5.1f}G  {c(33, caps)}{c(32, active)}")
                        else:
                            reason = st.get("reason", "")
                            say(c(31, f"  Ollama is NOT running at {OLLAMA_BASE}"))
                            if reason:
                                say(c(33, f"  Reason: {reason}"))
                            say(c(33, "  Fix: run  ollama serve  in another terminal"))
                        say("")
                elif cmd in ("/model",):
                    lowarg = arg.lower()
                    if not arg:
                        # Interactive picker: [1..5] API providers, [6..7] Ollama.
                        # When stdin is piped the menu still prints and the
                        # pick simply cancels (EOF) — never crashes.
                        _cli_model_menu()
                    elif lowarg in ("api", "picker", "menu"):
                        _cli_model_menu()
                    elif lowarg.startswith("ollama") or lowarg == "list":
                        # Ollama-only listing (old behaviour preserved).
                        _cli_show_ollama_models(arg)
                    elif lowarg == "auto":
                        _cli_set_api("", "")
                        _CLI_MODEL = ""
                        say(c(32, f"  CLI set to Ollama auto. Active: {_cli_active_backend()['label']}"))
                    elif ":" in lowarg or lowarg in CLI_API_PROVIDERS or lowarg.split(":")[0] in CLI_API_PROVIDERS:
                        pid = lowarg.split(":")[0]
                        model = arg.split(":", 1)[1].strip() if ":" in arg else ""
                        if pid not in CLI_API_PROVIDERS:
                            say(c(31, f"  Unknown API provider '{pid}'. Use: /model gemini|openai|groq|openrouter|anthropic"))
                        elif not _cli_vault_key(pid):
                            say(c(31, f"  No {CLI_API_PROVIDERS[pid]['label']} key in the vault."))
                            say(c(33, "  Add it in AURA Settings → AI Core (keys are stored encrypted), then restart the server."))
                        else:
                            _cli_set_api(pid, model)
                            say(c(32, f"  ◈ CLI now chats via {CLI_API_PROVIDERS[pid]['label']} "
                                      f"({model or CLI_API_PROVIDERS[pid]['default_model']})"))
                            if model:
                                say(c(33, "  Model must exist in your provider account or the call will 404."))
                    else:
                        _cli_pin_ollama(arg)
                    say("")
                elif cmd in ("/log",):
                    if arg.lower() in ("on", "yes", "1"):
                        _CLI_LOGS = True
                        say(c(32, "  Server logs: ON"))
                    elif arg.lower() in ("off", "no", "0"):
                        _CLI_LOGS = False
                        say(c(32, "  Server logs: OFF (banners and replies still print)"))
                    else:
                        say(f"  Server logs are {c(32, 'ON') if _CLI_LOGS else c(31, 'OFF')}. Usage: /log on|off")
                elif cmd in ("/clear", "cls"):
                    os.system("cls" if platform.system() == "Windows" else "clear")
                    _render_cli_banner()
                elif cmd in ("/exit", "/quit"):
                    say(c(31, "\n  Shutting down AURA server from CLI... Goodbye!\n"))
                    os._exit(0)
                else:
                    say(c(31, f"  Unknown command '{cmd}'. Type /help for available commands."))
            else:
                _cli_chat(user_input)

        except (KeyboardInterrupt, EOFError):
            say(c(31, "\n  Exiting CLI...\n"))
            break
        except Exception as e:
            say(c(31, f"  CLI error: {e}"))


def main():
    host = "" if ALLOW_LAN else "127.0.0.1"
    try:
        devices.set_port(PORT)
    except Exception:
        pass
    try:
        with ThreadedHTTPServer((host, PORT), Handler) as httpd:
            url = f"http://localhost:{PORT}/"
            _render_cli_banner()
            threading.Timer(1.0, lambda: webbrowser.open(url)).start()
            threading.Thread(target=_terminal_repl_loop, daemon=True).start()
            httpd.serve_forever()
    except OSError as e:
        say(f"\n  Port {PORT} unavailable ({e}). Try: python serve.py {PORT + 1}\n")
        sys.exit(1)
    except KeyboardInterrupt:
        say("\n  AURA offline.\n")


if __name__ == "__main__":
    main()
