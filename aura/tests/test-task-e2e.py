"""
AURA :: /task executed for real
===============================
Browser → agent loop → server → pyautogui, with keystrokes dispatched.

    cp tests/fake-pyautogui.py /tmp/pyautogui.py
    python3 tests/fake-agent-ollama.py &
    PYTHONPATH=/tmp python3 serve.py 8101 --allow-actions &
    python3 tests/test-task-e2e.py 8101
"""
import asyncio, sys, json
from playwright.async_api import async_playwright
PORT = sys.argv[1] if len(sys.argv)>1 else "8101"
P=[];F=[]
def ok(n,c,d=""):
    (P if c else F).append(n)
    print(("  \033[32m✓\033[0m " if c else "  \033[31m✗\033[0m ")+n+(f"  \033[90m{d}\033[0m" if d else ""))

async def main():
    async with async_playwright() as pw:
        b=await pw.chromium.launch(args=["--enable-unsafe-swiftshader","--no-sandbox",
            "--auto-accept-this-tab-capture","--auto-select-desktop-capture-source=Entire screen",
            "--use-fake-ui-for-media-stream","--use-fake-device-for-media-stream"])
        pg=await (await b.new_context(viewport={"width":1500,"height":950})).new_page()
        errs=[]
        pg.on("pageerror", lambda e: errs.append("PAGEERROR: "+str(e)))
        pg.on("console", lambda m: errs.append(m.text) if m.type=="error" and not m.text.startswith("INFO:") else None)
        pg.on("dialog", lambda d: asyncio.ensure_future(d.accept()))
        await pg.goto(f"http://127.0.0.1:{PORT}/", wait_until="load"); await pg.wait_for_timeout(7000)
        try: await pg.click("#boot-go", timeout=4000)
        except Exception:
            try: await pg.click("text=INITIALIZE", timeout=4000)
            except Exception: pass
        await pg.wait_for_timeout(6000)

        print("\n\033[36m▸ /task IS REGISTERED\033[0m")
        cmds = await pg.evaluate("""async () => {
            const { plugins } = await import('/js/core/plugins.js');
            return plugins.listCommands().map(c => c.name);
        }""")
        ok("/task exists", "task" in cmds)
        ok("/do still exists", "do" in cmds)

        print("\n\033[36m▸ running_apps BRIDGE ACTION\033[0m")
        ra = await pg.evaluate("async () => (await window.AURA.actions.run('running_apps', {}))")
        ok("running_apps responds", ra.get("ok") is not None, json.dumps(ra)[:110])

        print("\n\033[36m▸ FULL WHATSAPP TASK — browser → pyautogui\033[0m")
        await pg.evaluate("async () => { await window.AURA.actions.automationArm(); }")
        await pg.evaluate("""async () => {
            const { screenShare } = await import('/js/vision/screen-share.js');
            await screenShare.start();
        }""")
        # Reset the scripted model so the sequence starts at step 1.
        # Done from Python, not the page: the stub has no CORS headers, so a
        # browser fetch to it is (correctly) blocked and would log an error.
        import urllib.request
        try: urllib.request.urlopen("http://127.0.0.1:11434/__reset", timeout=4).read()
        except Exception: pass
        await pg.wait_for_timeout(300)

        r = await pg.evaluate("""async () => {
            const { plugins } = await import('/js/core/plugins.js');
            const t0 = Date.now();
            const r = await plugins.run('/task open whatsapp and message Fiona Harris saying Hi');
            return { out: (r.output||r.error||''), ms: Date.now()-t0 };
        }""")
        out = r["out"]
        ok("the task reported success", out.startswith("✅"), out[:180])
        ok("it opened WhatsApp", "Open whatsapp" in out, out[:200])
        ok("it typed the contact name", "Fiona Harris" in out, out[:220])
        ok("it typed the message", 'Type "Hi"' in out, out[:260])
        ok("it pressed enter", "Press ENTER" in out, out[:280])
        ok("it declared completion", "message sent" in out.lower(), out[:120])

        print("\n\033[36m▸ TRACE SHOWS EVERY STEP\033[0m")
        tr = await pg.evaluate("""() => {
            const steps = [...document.querySelectorAll('.trace-step .trace-label')].map(e=>e.textContent);
            return { panels: document.querySelectorAll('.trace').length, steps };
        }""")
        ok("a trace panel was created", tr["panels"]>0, f"{tr['panels']}")
        ok("steps are visible in the UI", len(tr["steps"])>=5, str(tr["steps"][:8]))

        print("\n\033[36m▸ /dev PAGE\033[0m")
        pg2 = await (await b.new_context()).new_page()
        await pg2.goto(f"http://127.0.0.1:{PORT}/dev", wait_until="load")
        await pg2.wait_for_timeout(1200)
        dev = await pg2.evaluate("""() => ({
            ver: document.getElementById('ver').textContent,
            cards: document.querySelectorAll('.card').length,
            rels: document.querySelectorAll('.rel').length,
            title: document.title,
            firstHeadline: document.querySelector('.rel-head')?.textContent || '',
        })""")
        ok("/dev renders a version", dev["ver"].startswith("v"), dev["ver"])
        ok("status cards render", dev["cards"] >= 5, str(dev["cards"]))
        ok("release notes render", dev["rels"] >= 4, str(dev["rels"]))
        ok("the newest release is expanded", len(dev["firstHeadline"]) > 10, dev["firstHeadline"][:70])
        ok("page title carries the version", "AURA v" in dev["title"], dev["title"])

        real=[e for e in errs if "favicon" not in e.lower() and "swiftshader" not in e.lower() and not e.startswith("INFO:")]
        print("\n\033[36m▸ CONSOLE\033[0m")
        ok("no console errors", not real, "; ".join(real[:2]))
        await b.close()
    print(f"\n  \033[32mPASS {len(P)}\033[0m  FAIL {len(F)}")
    if F: print("  Failed: "+", ".join(F)); sys.exit(1)
asyncio.run(main())
