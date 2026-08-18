#!/usr/bin/env python3
"""
AURA :: end-to-end Ollama test in a REAL browser
------------------------------------------------
Everything else is unit-level. This proves the whole chain works the way it
will on the user's Windows machine:

    browser → /api/ollama/* (same origin) → serve.py → Ollama

It starts a fake Ollama that reports a model set NOT matching any name AURA
ever hardcoded, then checks that AURA:

  1. discovers those exact names (never invents its own),
  2. routes to one of them,
  3. actually streams a reply from it,
  4. corrects a bogus model name instead of failing,
  5. never shows "Cannot reach Ollama" while Ollama is up.

Usage:  python3 tests/test-ollama-live.py
"""
import asyncio
import json
import os
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Deliberately unusual names: if AURA ever shows qwen2.5:3b etc, it invented it.
MODELS = [
    {"name": "tinydolphin:1.1b", "size": 700_000_000,
     "details": {"family": "llama", "parameter_size": "1.1B"}},
    {"name": "starcoder2:3b", "size": 1_700_000_000,
     "details": {"family": "starcoder2", "parameter_size": "3B"}},
]

pass_n = fail_n = 0


def rec(name, cond, detail=""):
    global pass_n, fail_n
    if cond:
        pass_n += 1
        print(f"  \033[32m✓\033[0m {name}" + (f"  \033[90m{detail}\033[0m" if detail else ""))
    else:
        fail_n += 1
        print(f"  \033[31m✗\033[0m {name}  \033[90m{detail}\033[0m")


def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


class FakeOllama(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    seen_models = []

    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path == "/api/tags":
            body = json.dumps({"models": MODELS}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_error(404)

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        payload = json.loads(self.rfile.read(n) or b"{}")
        if self.path == "/api/chat":
            FakeOllama.seen_models.append(payload.get("model"))
            reply = f"Running on {payload.get('model')}."
            chunks = ("".join(
                json.dumps({"message": {"content": w + " "}}) + "\n" for w in reply.split()
            ) + json.dumps({"done": True}) + "\n").encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson")
            self.send_header("Content-Length", str(len(chunks)))
            self.end_headers()
            self.wfile.write(chunks)
        else:
            self.send_error(404)


class Threaded(HTTPServer):
    daemon_threads = True

    def process_request(self, req, addr):
        threading.Thread(target=self._h, args=(req, addr), daemon=True).start()

    def _h(self, req, addr):
        try:
            self.finish_request(req, addr)
        except Exception:
            pass
        finally:
            try:
                self.shutdown_request(req)
            except Exception:
                pass


async def main():
    oport, aport = free_port(), free_port()
    fake = Threaded(("127.0.0.1", oport), FakeOllama)
    threading.Thread(target=fake.serve_forever, daemon=True).start()

    proc = subprocess.Popen(
        [sys.executable, "serve.py", str(aport), "--ollama", f"http://127.0.0.1:{oport}"],
        cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(2.5)

    print("\n\033[36m▸ OLLAMA END-TO-END (real browser)\033[0m")
    try:
        async with async_playwright() as pw:
            b = await pw.chromium.launch(args=["--no-sandbox"])
            page = await (await b.new_context()).new_page()
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))

            await page.goto(f"http://localhost:{aport}/", wait_until="domcontentloaded")
            await page.wait_for_function("()=>window.AURA && window.AURA.ai", timeout=25000)
            try:
                await page.click('[data-act="skip"]', timeout=4000)
            except Exception:
                pass
            await page.wait_for_timeout(2500)

            # 1 ── discovery returns the REAL names
            names = await page.evaluate(
                "async()=>{const r=await fetch('/api/ollama/status');const j=await r.json();return j.names;}")
            rec("discovers the real installed models", names == ["starcoder2:3b", "tinydolphin:1.1b"], str(names))

            # 2 ── the provider adapter holds no invented names
            adapter = await page.evaluate("""async()=>{
              const m = await import('/js/ai/providers.js');
              await m.ollama.refresh({force:true});
              return {installed:m.ollama.installed, def:m.ollama.defaultModel};
            }""")
            rec("adapter caches only real models",
                sorted(adapter["installed"]) == ["starcoder2:3b", "tinydolphin:1.1b"], str(adapter["installed"]))
            rec("adapter default is a real model",
                adapter["def"] in adapter["installed"], str(adapter["def"]))

            # 3 ── a bogus name is corrected, not sent
            fixed = await page.evaluate("""async()=>{
              const m = await import('/js/ai/providers.js');
              await m.ollama.refresh({force:true});
              return m.ollama.resolveModel('qwen2.5:3b');
            }""")
            rec("bogus model corrected to a real one",
                fixed["name"] in ["starcoder2:3b", "tinydolphin:1.1b"], str(fixed))
            rec("correction carries an explanation", bool(fixed.get("note")), str(fixed.get("note"))[:60])

            # 4 ── a real streamed reply through the proxy
            FakeOllama.seen_models.clear()
            reply = await page.evaluate("""async()=>{
              const m = await import('/js/ai/providers.js');
              let out='';
              for await (const d of m.ollama.stream({
                messages:[{role:'user',content:'hi'}], model:'tinydolphin:1.1b'})) out+=d;
              return out;
            }""")
            rec("streams a real reply via the proxy", "tinydolphin:1.1b" in reply, reply.strip()[:50])
            rec("the exact requested model was used",
                FakeOllama.seen_models == ["tinydolphin:1.1b"], str(FakeOllama.seen_models))

            # 5 ── an invented name never reaches Ollama
            FakeOllama.seen_models.clear()
            await page.evaluate("""async()=>{
              const m = await import('/js/ai/providers.js');
              let o=''; for await (const d of m.ollama.stream({
                messages:[{role:'user',content:'hi'}], model:'llama3.2:3b'})) o+=d;
              return o;
            }""")
            rec("uninstalled name never reaches Ollama",
                FakeOllama.seen_models and FakeOllama.seen_models[0] in
                ["starcoder2:3b", "tinydolphin:1.1b"], str(FakeOllama.seen_models))

            # 6 ── no "cannot reach Ollama" while it is plainly up
            await page.evaluate("()=>window.AURA.ai.resolve()")
            await page.wait_for_timeout(1200)
            txt = await page.inner_text("body")
            rec("no false 'Cannot reach Ollama' message",
                "Cannot reach Ollama" not in txt and "not reachable" not in txt)

            rec("no page errors", not errors, "; ".join(errors)[:90])
            await b.close()
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
        fake.shutdown()

    print(f"\n  \033[32mPASS {pass_n}\033[0m  " + (f"\033[31mFAIL {fail_n}\033[0m" if fail_n else "FAIL 0"))
    sys.exit(1 if fail_n else 0)


asyncio.run(main())
