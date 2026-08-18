"""
AURA :: model capability detection
==================================

THE BUG THIS EXISTS TO PREVENT
------------------------------
AURA decided whether a model could read images by running a REGEX ON ITS
NAME. The pattern knew `gemma3` but not `gemma4`, so a user holding
`gemma4:12b` — a fully multimodal model — was told "none of your models can
see images, pull one". They pulled a second vision model they did not need.

Name matching cannot be fixed by adding `gemma4` to the pattern; the next
family breaks it again. Ollama's `/api/show` returns a `capabilities` array
computed from the model's own GGUF metadata. That is ground truth and it is
what we now use.

These tests run against a stub that speaks the real /api/tags + /api/show
protocol, so they are deterministic and need no models installed.
"""
import json
import threading
import http.server
import socketserver
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import ollama_proxy

PASS = FAIL = 0


def ok(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  \033[32m✓\033[0m {name}" + (f"  \033[90m{detail}\033[0m" if detail else ""))
    else:
        FAIL += 1
        print(f"  \033[31m✗\033[0m {name}  \033[90m{detail}\033[0m")


# ── A stub that behaves like a modern Ollama ────────────────────────────
MODELS = {
    "gemma4:12b":        ["completion", "vision", "tools"],
    "gemma2:2b":         ["completion"],
    "qwen2.5vl:7b":      ["completion", "vision"],
    "qwen2.5-coder:7b":  ["completion", "tools"],
    "deepseek-r1:8b":    ["completion", "thinking"],
    "nomic-embed-text":  ["embedding"],
}
SHOW_CALLS = []


class Modern(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, obj, code=200):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        if self.path == "/api/tags":
            return self._send({"models": [
                {"name": n, "size": 5_000_000_000, "modified_at": "2026-01-01T00:00:00Z",
                 "details": {"family": n.split(":")[0], "parameter_size": "7B"}}
                for n in MODELS]})
        self._send({}, 404)

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(n) or b"{}")
        if self.path == "/api/show":
            name = body.get("model")
            SHOW_CALLS.append(name)
            if name in MODELS:
                return self._send({"capabilities": MODELS[name],
                                   "details": {"family": name.split(":")[0]}})
            return self._send({"error": "not found"}, 404)
        self._send({}, 404)


class Legacy(Modern):
    """Ollama < 0.6.0 — /api/show exists but has no capabilities field."""

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        json.loads(self.rfile.read(n) or b"{}")
        if self.path == "/api/show":
            return self._send({"details": {"family": "gemma"}})   # no capabilities
        self._send({}, 404)


def serve(handler, port):
    socketserver.TCPServer.allow_reuse_address = True
    srv = socketserver.ThreadingTCPServer(("127.0.0.1", port), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


# ══════════════════════════════════════════════════════════════════════
print("\n  CAPABILITIES FROM A MODERN OLLAMA\n")
srv = serve(Modern, 11701)
BASE = "http://127.0.0.1:11701"
ollama_proxy._CAP_CACHE.clear()

st = ollama_proxy.status(BASE)
ok("server reachable", st["running"], st.get("reason", ""))
ok("all 6 models listed", st["count"] == 6, str(st["count"]))

by = {m["name"]: m for m in st["models"]}
ok("gemma4:12b reports vision", "vision" in by["gemma4:12b"]["caps"],
   str(by["gemma4:12b"]["caps"]))
ok("gemma2:2b does NOT report vision", "vision" not in by["gemma2:2b"]["caps"])
ok("qwen2.5vl:7b reports vision", "vision" in by["qwen2.5vl:7b"]["caps"])
ok("nomic-embed-text reports embedding", "embedding" in by["nomic-embed-text"]["caps"])
ok("deepseek-r1 reports thinking", "thinking" in by["deepseek-r1:8b"]["caps"])

ok("status exposes a vision roster",
   sorted(st["vision"]) == ["gemma4:12b", "qwen2.5vl:7b"], str(st["vision"]))
ok("status exposes an embedding roster",
   st["embedding"] == ["nomic-embed-text"], str(st["embedding"]))
ok("status exposes a tools roster",
   sorted(st["tools"]) == ["gemma4:12b", "qwen2.5-coder:7b"], str(st["tools"]))

print("\n  THE ORIGINAL BUG IS DEAD\n")
ok("gemma4:12b is recognised WITHOUT any name pattern",
   "gemma4:12b" in st["vision"],
   "this is the exact model the user was wrongly told to replace")

print("\n  CACHING — /api/show is not hammered\n")
before = len(SHOW_CALLS)
ollama_proxy.status(BASE)
ok("second status makes zero extra /api/show calls",
   len(SHOW_CALLS) == before, f"{len(SHOW_CALLS) - before} extra")
ollama_proxy._CAP_CACHE.clear()
ollama_proxy.status(BASE)
ok("clearing the cache re-probes", len(SHOW_CALLS) > before)

print("\n  OPT-OUT\n")
plain = ollama_proxy.status(BASE, with_capabilities=False)
ok("with_capabilities=False skips probing", all(not m["caps"] for m in plain["models"]))
ok("model list is still complete", plain["count"] == 6)

srv.shutdown()

# ══════════════════════════════════════════════════════════════════════
print("\n  GRACEFUL ON AN OLDER OLLAMA (no capabilities field)\n")
srv2 = serve(Legacy, 11702)
ollama_proxy._CAP_CACHE.clear()
st2 = ollama_proxy.status("http://127.0.0.1:11702")
ok("still reports running", st2["running"])
ok("still lists every model", st2["count"] == 6)
ok("caps are empty, not invented", all(m["caps"] == [] for m in st2["models"]))
ok("vision roster is empty (client falls back to the name guess)",
   st2["vision"] == [])
srv2.shutdown()

print("\n  OLLAMA DOWN\n")
ollama_proxy._CAP_CACHE.clear()
st3 = ollama_proxy.status("http://127.0.0.1:11799", timeout=2)
ok("reports not-running rather than raising", st3["running"] is False)
ok("gives an actionable reason", "ollama serve" in st3.get("reason", ""))

print(f"\n  {PASS} passed, {FAIL} failed\n")
sys.exit(1 if FAIL else 0)
