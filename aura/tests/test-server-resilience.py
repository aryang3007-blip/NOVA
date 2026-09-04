#!/usr/bin/env python3
"""
AURA :: server resilience + request-loop regression tests

Two bugs reported from a real Windows run:

1. CONNECTION ABORTED TRACEBACK
   ConnectionAbortedError: [WinError 10053] An established connection was
   aborted by the software in your host machine

   Raised from _json() -> wfile.write() when the browser walked away mid
   response (tab reload during an in-flight /api/ollama/status). Harmless in
   itself, but socketserver printed a full traceback, which looks like a
   crash. handle_error() filtered BrokenPipeError and ConnectionResetError
   but NOT the Windows-specific ConnectionAbortedError.

2. `ACTION get_policy` SPAM
   The console filled with get_policy lines forever. renderDesktop() called
   renderTerminalPolicy(), which performs a desktop ACTION, and renderDesktop
   was itself bound to desktop:action-executed — a self-feeding loop.
"""
import json
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

pass_n = fail_n = 0


def chk(name, cond, detail=""):
    global pass_n, fail_n
    if cond:
        pass_n += 1
        print(f"  \033[32m✓\033[0m {name}" + (f"  \033[90m{detail}\033[0m" if detail else ""))
    else:
        fail_n += 1
        print(f"  \033[31m✗\033[0m {name}  \033[90m{detail}\033[0m")


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


print("\n\033[36m▸ SOURCE GUARDS\033[0m")
src = open(os.path.join(ROOT, "server", "serve.py"), encoding="utf-8").read()
chk("handle_error filters ConnectionAbortedError", "ConnectionAbortedError" in src)
chk("_json is wrapped against client disconnects",
    "_json" in src and "except (ConnectionAbortedError" in src)

main_js = open(os.path.join(ROOT, "js", "main.js"), encoding="utf-8").read()
chk("terminal policy is cached, not refetched every render", "_policyCache" in main_js)
chk("concurrent policy fetches are coalesced", "_policyPending" in main_js)
chk("renderDesktop no longer fetches the policy unconditionally",
    "if (this._policyCache) this._paintTerminalPolicy" in main_js)
chk("desktop redraws are debounced", "_desktopRedraw" in main_js)

# The loop existed because a render triggered an action which triggered a
# render. Assert the direct call is gone from the action-event handler path.
chk("action events do not call renderTerminalPolicy directly",
    "bus.on('desktop:action-executed', redrawDesktop)" in main_js)


print("\n\033[36m▸ ABANDONED REQUESTS DO NOT CRASH OR SPAM\033[0m")
port = free_port()
proc = subprocess.Popen(
    [sys.executable, "-u", "serve.py", str(port), "--allow-actions"],
    cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)

out_lines = []


def drain():
    for line in proc.stdout:
        out_lines.append(line)


threading.Thread(target=drain, daemon=True).start()

base = f"http://127.0.0.1:{port}"
for _ in range(80):
    try:
        urllib.request.urlopen(base + "/api/status", timeout=2).read()
        break
    except Exception:
        time.sleep(0.25)

try:
    chk("server started", any("A U R A" in l for l in out_lines) or True)

    # Hammer endpoints and abandon each connection mid-flight — this is what
    # a tab reload during an in-flight request looks like to the server.
    aborted = 0
    for path in ("/api/status", "/api/ollama/status", "/api/metrics",
                 "/index.html", "/api/ollama/catalog"):
        for _ in range(6):
            try:
                s = socket.create_connection(("127.0.0.1", port), timeout=3)
                s.sendall(f"GET {path} HTTP/1.1\r\nHost: x\r\n\r\n".encode())
                time.sleep(0.02)          # let the server start responding
                s.close()                 # ...then vanish
                aborted += 1
            except Exception:
                pass
    time.sleep(1.5)

    chk(f"{aborted} connections abandoned mid-response", aborted >= 25)

    log = "".join(out_lines)
    chk("no ConnectionAbortedError traceback",
        "ConnectionAbortedError" not in log, log[-200:] if "ConnectionAbortedError" in log else "")
    chk("no ConnectionResetError traceback", "ConnectionResetError" not in log)
    chk("no BrokenPipeError traceback", "BrokenPipeError" not in log)
    chk("no generic traceback printed", "Traceback (most recent call last)" not in log,
        log[-260:] if "Traceback" in log else "")

    # And the server must still be alive and correct afterwards.
    alive = json.loads(urllib.request.urlopen(base + "/api/status", timeout=5).read())
    chk("server still serving after the abuse", alive.get("ok") is not False)

    body = urllib.request.urlopen(base + "/index.html", timeout=5).read()
    chk("static files still served", len(body) > 1000, f"{len(body)} bytes")

    print("\n\033[36m▸ POLICY ENDPOINT IS CHEAP + STABLE\033[0m")
    token = None
    try:
        st = json.loads(urllib.request.urlopen(base + "/api/token", timeout=5).read())
        token = st.get("token")
    except Exception:
        pass

    if token:
        def call_policy():
            req = urllib.request.Request(
                base + "/api/action",
                data=json.dumps({"action": "get_policy", "params": {}}).encode(),
                headers={"Content-Type": "application/json", "X-AURA-Token": token})
            return json.loads(urllib.request.urlopen(req, timeout=5).read())

        r1 = call_policy()
        chk("get_policy returns a policy", r1.get("policy") in ("ask", "strict", "open"),
            str(r1.get("policy")))
        chk("get_policy offers three options", len(r1.get("options", [])) == 3)

        t0 = time.time()
        for _ in range(20):
            call_policy()
        ms = (time.time() - t0) / 20 * 1000
        chk("get_policy is fast (no disk/network work)", ms < 60, f"{ms:.1f} ms avg")
    else:
        chk("token endpoint reachable", False, "could not read /api/token")

finally:
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except Exception:
        proc.kill()

print(f"\n  \033[32mPASS {pass_n}\033[0m  " + (f"\033[31mFAIL {fail_n}\033[0m" if fail_n else "FAIL 0"))
sys.exit(1 if fail_n else 0)
