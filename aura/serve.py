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
It is OFF by default. See bridge.py for the full security model.
"""
import http.server
import socketserver
import json
import os
import platform
import secrets
import sys
import threading
import urllib.request
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


ROOT = os.path.dirname(os.path.abspath(__file__))

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
    import ollama_proxy
except Exception as e:                     # pragma: no cover
    ollama_proxy = None
    say(f"  !! ollama_proxy.py unavailable: {e}")

# Device gateway (phone companion). Stdlib-only, so this should never fail —
# but AURA must still boot without it rather than dying at import time.
try:
    import devices
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
        import bridge as _bridge
        bridge = _bridge
    except Exception as e:                    # pragma: no cover
        say(f"  !! bridge.py failed to import: {e}")
        ALLOW_ACTIONS = False


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
            ts = payload.get("timestamp", _t_start.time())

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
            say(c(32, f"  🎙 WAKE EVENT RECEIVED: {phrase} (score: {score:.2f}, source: {source})"))
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
                        say(c(33, f"  {glyph(chr(0x21bb), '~')} model '{want}' -> '{real}'"))
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
                say(c(36, f"  {glyph(chr(0x2b07), 'v')} pulling model: {model}"))
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
        say(f"  {icon} ACTION {action} {detail} -> {result.get('message', '')}")
        return self._json(result)

    def do_OPTIONS(self):
        # No CORS allow-origin on purpose → cross-site preflight fails.
        self.send_response(204)
        self.end_headers()

    def log_message(self, fmt, *a):
        msg = fmt % a
        if "favicon" in msg or "apple-touch-icon" in msg:
            return
        if " 404 " in msg or " 500 " in msg:
            say(c(31, msg))


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
        ("/model", "Switch model"),
        ("/doc", "Doc capabilities"),
        ("/policy", "Action policy"),
        ("/clear", "Clear chat"),
        ("/exit", "Exit CLI")
    ]
    col_widths = [15, 15, 15, 15, 15, 14]

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


def _cli_chat(text):
    global _CLI_MODEL
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
        "messages": [
            {"role": "system", "content": "You are AURA, a concise AI assistant in a terminal CLI. Keep answers short and direct. Use plain text, avoid markdown except for code blocks."},
            {"role": "user", "content": text}
        ],
        "stream": True
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
                    say(f"  {c(33, '/model')}               List installed Ollama models")
                    say(f"  {c(33, '/model <name>')}       Pin CLI chat to a specific model")
                    say(f"  {c(33, '/model auto')}          Auto-pick best available model")
                    say(f"  {c(33, '/doc')}                 Check document generator capabilities")
                    say(f"  {c(33, '/policy')}              View Action Bridge security policy")
                    say(f"  {c(33, '/status')}              System telemetry (CPU, RAM, Ollama)")
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

                        # Extract clean topic
                        import re
                        topic = re.sub(r"^(ppt|pptx|powerpoint|slides|presentation|sheet|excel|xlsx|spreadsheet|report|doc|docx|word|essay)\s+(on|about|for|of)?\s*", "", arg, flags=re.I).strip()
                        topic = re.sub(r"^(on|about|for|of)\s+", "", topic, flags=re.I).strip() or "Analysis"

                        caps = docbuilder.capabilities()
                        if not caps.get(kind):
                            say(c(31, f"\n  ✗ {kind.upper()} generation needs a Python library: {caps.get('install', {}).get(kind, 'pip install')}\n"))
                            continue

                        say(f"\n  {c(33, '⚡ Generating')} {kind.upper()} for: {c(36, topic)}...")
                        import datetime
                        today_str = datetime.date.today().strftime('%d %B %Y')
                        if kind == "pptx":
                            spec = {
                                "title": topic.title(),
                                "subtitle": f"AURA Intelligence Briefing · {today_str}",
                                "slides": [
                                    {"title": f"Overview of {topic.title()}", "bullets": [f"Key contextual factors and drivers for {topic}", "Current landscape, observations, and modern trends", "Strategic scope and objectives"]},
                                    {"title": "Key Dynamics & Assessment", "bullets": ["Primary findings and data indicators", "Risk vectors, challenge areas, and critical bottlenecks", "Comparative impact across operational areas"]},
                                    {"title": "Strategic Recommendations", "bullets": ["High-priority action items for stakeholders", "Policy frameworks, standards, and practical methods", "Resource allocation and timeline milestones"]},
                                    {"title": "Summary & Next Steps", "bullets": ["Core takeaways synthesized", "Future outlook and progressive roadmap", "Action items and ongoing measurement"]}
                                ]
                            }
                        elif kind == "xlsx":
                            spec = {
                                "title": f"{topic.title()} Summary",
                                "sheets": [{
                                    "name": "Summary",
                                    "columns": ["Item / Metric", "Category", "Baseline", "Target", "Status", "Notes"],
                                    "rows": [
                                        [f"{topic.title()} - Primary Factor", "Strategic", 100, 150, "Active", "On schedule"],
                                        [f"{topic.title()} - Operational Metric", "Core", 85, 95, "Review", "Quarterly evaluation"],
                                        [f"{topic.title()} - Performance Target", "Growth", 210, 280, "Active", "High priority"],
                                        ["Summary Total", "Aggregate", 395, 525, "On Track", "Baseline tracking"]
                                    ]
                                }]
                            }
                        else:
                            spec = {
                                "title": f"Report: {topic.title()}",
                                "subtitle": f"AURA Comprehensive Analysis · {today_str}",
                                "sections": [
                                    {"heading": "Executive Summary", "level": 1, "paragraphs": [f"This report provides an in-depth, structured evaluation of {topic}. It outlines the primary background, current operational and situational landscape, and strategic recommendations for stakeholders."], "bullets": [f"Clear synthesis of current {topic} developments", "Evaluation of critical risk vectors and opportunities"]},
                                    {"heading": "Context & Background", "level": 1, "paragraphs": [f"Understanding {topic} requires examining both historical precedents and recent shifts in the operational environment. Key data points highlight growing urgency and notable systemic patterns."]},
                                    {"heading": "Analysis & Findings", "level": 1, "paragraphs": [f"Analysis indicates multiple intersecting dynamics across {topic}. Proactive intervention and systematic measurement remain vital for sustainable outcomes."], "bullets": ["Primary finding 1: Core trend identification and impact", "Primary finding 2: Strategic dependencies and vulnerability areas", "Primary finding 3: Resource allocation and implementation factors"]},
                                    {"heading": "Recommendations & Next Steps", "level": 1, "paragraphs": [f"To effectively navigate challenges surrounding {topic}, structured milestones and continuous assessment must be prioritized."], "bullets": ["Immediate action items (30-60 days)", "Medium-term strategic initiatives", "Long-term governance and review process"]}
                                ]
                            }

                        res = docbuilder.build(kind, spec, folder=docbuilder.default_folder(), resolver=bridge._resolve_path if bridge else None)
                        if res.get("ok"):
                            kb = round(res.get('bytes', 0) / 1024, 1)
                            say(f"  {c(32, '✓ CREATED:')} {res.get('path')} ({kb} KB)\n")
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
                    if not ollama_proxy:
                        say(c(31, "  Ollama proxy module unavailable."))
                    else:
                        st = ollama_proxy.status(OLLAMA_BASE)
                        if not st.get("running"):
                            say(c(31, "  Ollama not running — cannot list models."))
                        elif not arg or arg.lower() == "list":
                            models = st.get("models", [])
                            if not models:
                                say(c(33, "  No models installed. Run: ollama pull gemma2:2b"))
                            else:
                                say("\n" + c(36, "  Installed Ollama models:"))
                                for i, m in enumerate(models):
                                    name   = m.get("name", "?")
                                    params = m.get("params") or "?"
                                    size   = m.get("size_gb") or 0
                                    marker = c(32, " ◄ active") if name == _CLI_MODEL else (c(37, " [auto]") if i == 0 and not _CLI_MODEL else "")
                                    say(f"  [{i+1}] {c(36, name)}  {params}  {size:.1f}G{marker}")
                                say(f"\n  {c(37, 'Tip:')} /model <name> to pin, /model auto to reset")
                        elif arg.lower() == "auto":
                            _CLI_MODEL = ""
                            say(c(32, "  Model set to auto (first available chat model)"))
                        else:
                            names = st.get("names", [])
                            match = next((n for n in names if n == arg), None)
                            if not match:
                                match = next((n for n in names if n.lower().startswith(arg.lower())), None)
                            if not match:
                                match = next((n for n in names if arg.lower() in n.lower()), None)
                            if match:
                                _CLI_MODEL = match
                                say(c(32, f"  ◈ Pinned CLI to: {match}"))
                                say(c(37,  "  Type any message to chat with this model"))
                            else:
                                say(c(31, f"  Model '{arg}' not found."))
                                say(c(33, f"  Installed: {', '.join(names) or 'none'}"))
                                say(c(37,  "  Run /model to list available models"))
                        say("")
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
