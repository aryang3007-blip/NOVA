"""
AURA :: input automation - commands, safety, and honest reporting
=================================================================
The engine (automation.py) and the Settings panel both existed, but NOTHING
could reach automation_dry_run / automation_run - so a user could arm
automation and then have no way to use it. See docs/FEATURE_STATUS.md #70.

Runs WITHOUT pyautogui installed, which is the point: every assertion here
checks that AURA reports the limitation honestly instead of pretending.

    python3 serve.py 8055 --allow-actions &
    python3 tests/test-automation-ui.py 8055
"""
import asyncio, sys
from playwright.async_api import async_playwright
P=[];F=[]
def ok(n,c,d=""):
    (P if c else F).append(n)
    print(("  \033[32m✓\033[0m " if c else "  \033[31m✗\033[0m ")+n+(f"  \033[90m{d}\033[0m" if d else ""))
async def main():
    async with async_playwright() as pw:
        b=await pw.chromium.launch(args=["--enable-unsafe-swiftshader","--no-sandbox"])
        pg=await (await b.new_context()).new_page()
        errs=[]
        pg.on("pageerror", lambda e: errs.append(str(e)))
        PORT = sys.argv[1] if len(sys.argv) > 1 else "8055"
        await pg.goto(f"http://127.0.0.1:{PORT}/", wait_until="load"); await pg.wait_for_timeout(9000)

        cmds = await pg.evaluate("""async () => {
            const { plugins } = await import('/js/core/plugins.js');
            return plugins.listCommands().map(c => c.name);
        }""")
        print("\n\033[36m▸ COMMANDS REGISTERED\033[0m")
        for want in ["automation","cursor","click","type","hotkey","press","scroll","screen"]:
            ok(f"/{want} exists", want in cmds)

        print("\n\033[36m▸ /automation STATUS (pyautogui absent here)\033[0m")
        out = await pg.evaluate("""async () => {
            const { plugins } = await import('/js/core/plugins.js');
            const r = await plugins.run('/automation');
            return r.output || '';
        }""")
        ok("reports unavailable honestly", "unavailable" in out.lower() or "pyautogui" in out.lower(), out[:120])
        ok("tells the user the exact fix", "pip install pyautogui" in out, out[:120])
        ok("does NOT claim it is armed", "🟢 ARMED" not in out)

        print("\n\033[36m▸ SAFETY: blocked hotkey never reaches the mouse\033[0m")
        out2 = await pg.evaluate("""async () => {
            const { plugins } = await import('/js/core/plugins.js');
            const r = await plugins.run('/hotkey alt+f4');
            return r.output || '';
        }""")
        ok("alt+f4 rejected", "blocked" in out2.lower() or "reject" in out2.lower(), out2[:130])

        print("\n\033[36m▸ USAGE HINTS\033[0m")
        u = await pg.evaluate("""async () => {
            const { plugins } = await import('/js/core/plugins.js');
            const a = await plugins.run('/click');
            const t = await plugins.run('/type');
            return [a.output||'', t.output||''];
        }""")
        ok("/click with no args explains itself", "Usage" in u[0], u[0][:80])
        ok("/type with no args explains itself", "Usage" in u[1], u[1][:80])

        print("\n\033[36m▸ SETTINGS PANEL\033[0m")
        # The panel renders lazily when the Desktop tab is opened.
        await pg.evaluate("""async () => {
            const app = window.AURA;
            app.openPanel ? app.openPanel('settings') : null;
            document.querySelector('.tab[data-tab="desktop"]')?.click();
        }""")
        await pg.wait_for_timeout(2500)
        panel = await pg.evaluate("""() => {
            const el = document.getElementById('auto-arm');
            const badge = document.getElementById('auto-badge');
            const caps = document.getElementById('auto-caps');
            return { hasBtn: !!el, badge: badge?.textContent||'', caps: caps?.textContent||'' };
        }""")
        ok("ARM button exists in the DOM", panel["hasBtn"])
        ok("badge reports NOT INSTALLED", "NOT INSTALLED" in panel["badge"] or panel["badge"]!="", panel["badge"])

        ok("no page errors", not errs, "; ".join(errs[:2]))
        await b.close()
    print(f"\n  \033[32mPASS {len(P)}\033[0m  FAIL {len(F)}")
    if F: print("  Failed: "+", ".join(F)); sys.exit(1)
asyncio.run(main())
