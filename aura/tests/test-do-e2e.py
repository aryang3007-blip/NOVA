"""
AURA :: /do executed for real
=============================
Browser → server → pyautogui, with keystrokes actually dispatched.

Uses tests/fake-pyautogui.py so the whole chain runs headless:

    cp tests/fake-pyautogui.py /tmp/pyautogui.py
    python3 tests/fake-real-ollama.py &
    PYTHONPATH=/tmp python3 serve.py 8093 --allow-actions &
    python3 tests/test-do-e2e.py 8093
"""
import asyncio, sys, json
from playwright.async_api import async_playwright
PORT = sys.argv[1] if len(sys.argv)>1 else "8093"
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

        print("\n\033[36m▸ FULL /do EXECUTION — browser → server → pyautogui\033[0m")
        arm = await pg.evaluate("async () => (await window.AURA.actions.automationArm())")
        ok("automation arms", arm.get("ok"), str(arm.get("message",""))[:70])
        cap = await pg.evaluate("async () => (await window.AURA.actions.automationCapabilities())")
        ok("pyautogui available on the server", cap.get("available"), str(cap.get("reason",""))[:60])

        r = await pg.evaluate("""async () => {
            const { plugins } = await import('/js/core/plugins.js');
            const t0 = Date.now();
            const r = await plugins.run('/do close the open window');
            return { out: (r.output||r.error||'').slice(0,240), ms: Date.now()-t0 };
        }""")
        ok("/do close the open window SUCCEEDS", r["out"].startswith("✅"), r["out"][:140])
        ok("and it was instant", r["ms"] < 4000, f"{r['ms']}ms")

        r2 = await pg.evaluate("""async () => {
            const { plugins } = await import('/js/core/plugins.js');
            const r = await plugins.run('/do save the file');
            return (r.output||r.error||'').slice(0,160);
        }""")
        ok("/do save the file SUCCEEDS", r2.startswith("✅"), r2[:120])

        print("\n\033[36m▸ /do WITH THE SCREEN (messy model output)\033[0m")
        await pg.evaluate("""async () => {
            const { screenShare } = await import('/js/vision/screen-share.js');
            await screenShare.start();
        }""")
        r3 = await pg.evaluate("""async () => {
            const { plugins } = await import('/js/core/plugins.js');
            const r = await plugins.run('/do click the close button');
            return (r.output||r.error||'').slice(0,240);
        }""")
        ok("/do click ... produced a real result", r3.startswith("✅") or "Click" in r3, r3[:150])

        real=[e for e in errs if "favicon" not in e.lower() and "swiftshader" not in e.lower() and not e.startswith("INFO:")]
        print("\n\033[36m▸ CONSOLE\033[0m")
        ok("no console errors", not real, "; ".join(real[:2]))
        await b.close()
    print(f"\n  \033[32mPASS {len(P)}\033[0m  FAIL {len(F)}")
    if F: print("  Failed: "+", ".join(F)); sys.exit(1)
asyncio.run(main())
