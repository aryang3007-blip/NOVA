#!/usr/bin/env python3
"""
AURA :: server concurrency regression test
------------------------------------------
Reproduces the REAL cause of the user's

    "Ollama (local) failed: Cannot reach Ollama ... (Failed to fetch)"

The old serve.py used a single-threaded socketserver.TCPServer. One slow
/api/ollama/chat request (a cold model load is routinely 20-90s) occupied the
only server thread, so every other request — /api/ollama/status, /api/metrics,
even static files — queued behind it until the browser timed out and reported
"Failed to fetch". Ollama was fine; our server was the bottleneck.

This test starts AURA's real server pointed at a deliberately SLOW fake
Ollama, fires a chat request, and then checks that unrelated requests are
still answered promptly while that chat is still streaming.
"""
import json
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, HTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

pass_n = 0
fail_n = 0


def chk(name, cond, detail=""):
    global pass_n, fail_n
    if cond:
        pass_n += 1
        print(f"  \033[32m✓\033[0m {name}")
    else:
        fail_n += 1
        print(f"  \033[31m✗\033[0m {name} {detail}")


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


# ── a fake Ollama whose /api/chat takes 6 seconds ────────────────────────
CHAT_DELAY = 6.0


class SlowOllama(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path == "/api/tags":
            body = json.dumps({"models": [
                {"name": "gemma2:2b", "size": 1_600_000_000,
                 "details": {"family": "gemma2", "parameter_size": "2.6B"}},
            ]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_error(404)

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        self.rfile.read(n)
        if self.path == "/api/chat":
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson")
            self.end_headers()
            time.sleep(CHAT_DELAY)          # simulate a cold model load
            self.wfile.write(b'{"message":{"content":"ok"}}\n{"done":true}\n')
            self.wfile.flush()
        else:
            self.send_error(404)


class ThreadedFake(HTTPServer):
    daemon_threads = True

    def process_request(self, request, client_address):
        t = threading.Thread(target=self._h, args=(request, client_address), daemon=True)
        t.start()

    def _h(self, request, client_address):
        try:
            self.finish_request(request, client_address)
        except Exception:
            pass
        finally:
            try:
                self.shutdown_request(request)
            except Exception:
                pass


def main():
    ollama_port = free_port()
    aura_port = free_port()

    fake = ThreadedFake(("127.0.0.1", ollama_port), SlowOllama)
    threading.Thread(target=fake.serve_forever, daemon=True).start()

    proc = subprocess.Popen(
        [sys.executable, "serve.py", str(aura_port),
         "--ollama", f"http://127.0.0.1:{ollama_port}"],
        cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    base = f"http://127.0.0.1:{aura_port}"

    try:
        # wait for boot
        for _ in range(60):
            try:
                urllib.request.urlopen(base + "/api/ollama/status", timeout=2).read()
                break
            except Exception:
                time.sleep(0.25)
        else:
            chk("server started", False, "never came up")
            return

        chk("server started", True)

        # models are discovered from the fake /api/tags, not hardcoded
        st = json.loads(urllib.request.urlopen(base + "/api/ollama/status", timeout=5).read())
        chk("status lists the REAL installed model",
            st.get("names") == ["gemma2:2b"], str(st.get("names")))

        # catalog must not invent models
        cat = json.loads(urllib.request.urlopen(base + "/api/ollama/catalog", timeout=5).read())
        names = [m["name"] for m in cat.get("models", [])]
        chk("catalog returns only installed models", names == ["gemma2:2b"], str(names))
        chk("no suggestions when models exist", cat.get("suggested") == [], str(cat.get("suggested")))

        # ── the actual concurrency check ────────────────────────────────
        result = {}

        def slow_chat():
            t0 = time.time()
            try:
                r = urllib.request.urlopen(
                    urllib.request.Request(
                        base + "/api/ollama/chat",
                        data=json.dumps({"model": "gemma2:2b", "messages": []}).encode(),
                        headers={"Content-Type": "application/json"}),
                    timeout=30)
                r.read()
                result["chat"] = time.time() - t0
            except Exception as e:
                result["chat_err"] = str(e)

        th = threading.Thread(target=slow_chat, daemon=True)
        th.start()
        time.sleep(1.0)                     # ensure the chat is mid-flight

        t0 = time.time()
        try:
            urllib.request.urlopen(base + "/api/ollama/status", timeout=5).read()
            status_ms = (time.time() - t0) * 1000
        except Exception as e:
            status_ms = 99999
            print(f"      status failed: {e}")

        chk("status responds while a slow chat is streaming (<2s)",
            status_ms < 2000, f"took {status_ms:.0f}ms")

        t0 = time.time()
        try:
            urllib.request.urlopen(base + "/index.html", timeout=5).read()
            static_ms = (time.time() - t0) * 1000
        except Exception as e:
            static_ms = 99999
            print(f"      static failed: {e}")

        chk("static assets still served during a slow chat (<2s)",
            static_ms < 2000, f"took {static_ms:.0f}ms")

        # a wrong model name must be corrected, not 404'd
        req = urllib.request.Request(
            base + "/api/ollama/chat",
            data=json.dumps({"model": "qwen2.5:3b", "messages": []}).encode(),
            headers={"Content-Type": "application/json"})
        r = urllib.request.urlopen(req, timeout=30)
        note = r.headers.get("X-AURA-Model-Note")
        r.read()
        chk("uninstalled model name is corrected server-side",
            bool(note) and "gemma2:2b" in note, str(note))

        th.join(timeout=30)
        chk("the slow chat itself still completed", "chat" in result, str(result))

    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
        fake.shutdown()

    print(f"\n  PASS {pass_n}  FAIL {fail_n}")
    sys.exit(1 if fail_n else 0)


if __name__ == "__main__":
    main()
