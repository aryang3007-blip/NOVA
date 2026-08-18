"""
AURA :: AURA Live page (/screen)
================================
Every screen command must have a real control, and the old sidebar panel must
be gone without breaking the main app.

    cp tests/fake-pyautogui.py /tmp/pyautogui.py
    python3 tests/fake-screen-ollama.py &
    PYTHONPATH=/tmp python3 serve.py 8131 --allow-actions &
    python3 tests/test-live-page.py 8131
"""
import asyncio, sys
from playwright.async_api import async_playwright
PORT = sys.argv[1] if len(sys.argv) > 1 else "8131"
P = []; F = []
def ok(n, c, d=""):
    (P if c else F).append(n)
    print(("  \033[32m✓\033[0m " if c else "  \033[31m✗\033[0m ") + n + (f"  \033[90m{d}\033[0m" if d else ""))

async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch(args=["--enable-unsafe-swiftshader","--no-sandbox",
            "--auto-accept-this-tab-capture","--auto-select-desktop-capture-source=Entire screen",
            "--use-fake-ui-for-media-stream","--use-fake-device-for-media-stream"])
        ctx = await b.new_context(viewport={"width":1600,"height":1000})
        pg = await ctx.new_page()
        errs = []
        pg.on("pageerror", lambda e: errs.append("PAGEERROR: " + str(e)))
        pg.on("console", lambda m: errs.append(m.text)
              if m.type == "error" and not m.text.startswith("INFO:") else None)
        pg.on("dialog", lambda d: asyncio.ensure_future(d.accept()))

        await pg.goto(f"http://127.0.0.1:{PORT}/screen", wait_until="load")
        await pg.wait_for_timeout(4000)

        print("\n\033[36m▸ PAGE LOADS\033[0m")
        ok("title is AURA Live", "AURA Live" in await pg.title(), await pg.title())
        shell = await pg.evaluate("""() => ({
            rail: document.querySelectorAll('.rail-btn[data-view]').length,
            views: document.querySelectorAll('.view').length,
            glass: document.querySelectorAll('.glass').length,
            orbs: document.querySelectorAll('.orb').length,
            omni: !!document.getElementById('omni'),
        })""")
        ok("floating sidebar has all sections", shell["rail"] == 7, str(shell["rail"]))
        ok("all views present", shell["views"] == 7, str(shell["views"]))
        ok("glass surfaces render", shell["glass"] >= 8, str(shell["glass"]))
        ok("ambient light field present", shell["orbs"] == 4, str(shell["orbs"]))
        ok("floating search bar present", shell["omni"])

        print("\n\033[36m▸ EVERY COMMAND HAS A CONTROL\033[0m")
        ctrls = await pg.evaluate("""() => {
            const has = id => !!document.getElementById(id);
            return {
              watch: has('btn-share') && has('btn-stop'),
              ask: has('btn-ask') && has('ask-q'),
              screenmode: document.querySelectorAll('.mode').length === 3,
              find: has('btn-find') && has('find-q'),
              here: has('btn-here'),
              do_task: document.querySelectorAll('#act-seg button').length === 2 && has('btn-act'),
              reticle: has('btn-ret-test') && has('btn-ret-off'),
              colors: document.querySelectorAll('#ret-colors .sw').length,
              desktop: has('btn-vd-setup') && has('btn-vd-aura') && has('btn-vd-home'),
              automation: has('btn-arm') && has('btn-disarm'),
              trace: has('trace-log'),
              grid: document.querySelectorAll('#gridmap .gcell').length,
            };
        }""")
        for k, label in [("watch","/watch"),("ask","/watch ask"),("screenmode","/screenmode"),
                         ("find","/find"),("here","/here"),("do_task","/do + /task"),
                         ("reticle","/reticle"),("desktop","/desktop"),
                         ("automation","/automation"),("trace","trace")]:
            ok(f"{label} has a UI control", ctrls[k] is True, str(ctrls[k]))
        ok("marker colour picker", ctrls["colors"] == 6, str(ctrls["colors"]))
        ok("grid map is 12x8", ctrls["grid"] == 96, str(ctrls["grid"]))

        print("\n\033[36m▸ NAVIGATION\033[0m")
        for view in ["ask","find","act","desktop","trace","settings","live"]:
            active = await pg.evaluate(f"""async () => {{
                document.querySelector('.rail-btn[data-view="{view}"]').click();
                await new Promise(r => setTimeout(r, 380));
                return document.querySelector('.view[data-view="{view}"]').classList.contains('active');
            }}""")
            ok(f"{view} view opens", active)

        print("\n\033[36m▸ SCREEN SHARING WORKS FROM THIS PAGE\033[0m")
        sh = await pg.evaluate("""async () => {
            document.querySelector('.rail-btn[data-view="live"]').click();
            await new Promise(r => setTimeout(r, 300));
            document.getElementById('btn-share').click();
            await new Promise(r => setTimeout(r, 2500));
            const { screenShare } = await import('/js/vision/screen-share.js');
            const cv = document.getElementById('preview');
            const ctx = cv.getContext('2d');
            let bright = 0;
            if (cv.width) {
              const d = ctx.getImageData(0,0,cv.width,cv.height).data;
              for (let i=0;i<d.length;i+=4000) if (d[i]+d[i+1]+d[i+2] > 30) bright++;
            }
            return { active: screenShare.active, pill: document.getElementById('pill-share').textContent.trim(),
                     w: cv.width, bright,
                     surface: document.getElementById('surface-line').textContent };
        }""")
        ok("sharing starts", sh["active"], str(sh["active"]))
        ok("status pill updates", "SHARING" in sh["pill"], sh["pill"])
        ok("preview canvas is sized", sh["w"] > 0, str(sh["w"]))
        ok("preview actually renders pixels", sh["bright"] > 0, f"{sh['bright']} samples")
        ok("surface is described", "screen" in sh["surface"].lower(), sh["surface"][:60])

        print("\n\033[36m▸ FIND + GRID MAP\033[0m")
        fr = await pg.evaluate("""async () => {
            document.querySelector('.rail-btn[data-view="find"]').click();
            await new Promise(r => setTimeout(r, 300));
            document.getElementById('find-q').value = 'Save';
            document.getElementById('btn-find').click();
            await new Promise(r => setTimeout(r, 4000));
            return { out: document.getElementById('find-out').textContent.slice(0,140),
                     cell: document.getElementById('grid-cell').textContent,
                     hits: document.querySelectorAll('#gridmap .gcell.hit').length };
        }""")
        ok("find returns a result", len(fr["out"]) > 10, fr["out"][:90])
        ok("grid cell is reported", fr["cell"] != "—", fr["cell"])
        ok("grid map highlights the cell", fr["hits"] == 1, str(fr["hits"]))

        print("\n\033[36m▸ READING MODE PICKER = /screenmode\033[0m")
        mode = await pg.evaluate("""async () => {
            document.querySelector('.rail-btn[data-view="ask"]').click();
            await new Promise(r => setTimeout(r, 300));
            document.querySelector('.mode[data-mode="ocr"]').click();
            await new Promise(r => setTimeout(r, 250));
            const { config } = await import('/js/core/config.js');
            return { saved: config.get('screenMode'),
                     on: document.querySelector('.mode[data-mode="ocr"]').classList.contains('on') };
        }""")
        ok("mode change persists to config", mode["saved"] == "ocr", str(mode["saved"]))
        ok("selection is reflected in the UI", mode["on"])

        print("\n\033[36m▸ ANDROID = HONEST 'UNDER DEVELOPMENT'\033[0m")
        andro = await pg.evaluate("""async () => {
            document.getElementById('btn-android').click();
            await new Promise(r => setTimeout(r, 400));
            const m = document.getElementById('modal');
            const body = document.getElementById('modal-b').textContent;
            const shown = !m.hidden;
            document.getElementById('modal-x').click();
            await new Promise(r => setTimeout(r, 300));
            return { shown, body, closed: m.hidden };
        }""")
        ok("android button shows a modal", andro["shown"])
        ok("it says under development", "development" in andro["body"].lower(), andro["body"][:70])
        ok("it does NOT imply a hidden feature",
           "nothing about it works yet" in andro["body"].lower(), andro["body"][-90:])
        ok("modal closes", andro["closed"])

        print("\n\033[36m▸ TRACE STREAMS ON THIS PAGE\033[0m")
        tr = await pg.evaluate("""() => ({
            panels: document.querySelectorAll('.trace').length,
            steps: document.querySelectorAll('.trace-step').length })""")
        ok("traces were recorded", tr["panels"] > 0, str(tr["panels"]))
        ok("steps are visible", tr["steps"] > 0, str(tr["steps"]))

        print("\n\033[36m▸ MAIN APP STILL WORKS\033[0m")
        pg2 = await ctx.new_page()
        errs2 = []
        pg2.on("pageerror", lambda e: errs2.append(str(e)))
        await pg2.goto(f"http://127.0.0.1:{PORT}/", wait_until="load")
        await pg2.wait_for_timeout(6000)
        try: await pg2.click("#boot-go", timeout=4000)
        except Exception:
            try: await pg2.click("text=INITIALIZE", timeout=4000)
            except Exception: pass
        await pg2.wait_for_timeout(6000)
        main = await pg2.evaluate("""async () => {
            const { plugins } = await import('/js/core/plugins.js');
            const names = plugins.listCommands().map(c => c.name);
            return {
              cmds: names.length,
              keep: ['watch','find','do','task','reticle','desktop','screenmode','here']
                      .filter(n => names.includes(n)),
              liveLink: document.getElementById('dock-live')?.getAttribute('href'),
              noPanel: !document.querySelector('section[data-panel="screen"]'),
              traceLog: !!document.getElementById('trace-log'),
              panels: window.AURA.visiblePanels(),
            };
        }""")
        ok("all screen commands still registered", len(main["keep"]) == 8, str(main["keep"]))
        ok("command count healthy", main["cmds"] >= 65, str(main["cmds"]))
        ok("dock links to /screen", main["liveLink"] == "/screen", str(main["liveLink"]))
        ok("old sidebar panel is gone", main["noPanel"])
        ok("trace log still mounted in the main app", main["traceLog"])
        ok("no dangling screen panel in the dock",
           "screen" not in main["panels"], str(main["panels"]))
        ok("main app has no page errors", not errs2, "; ".join(errs2[:2]))

        real = [e for e in errs if "favicon" not in e.lower()
                and "swiftshader" not in e.lower() and not e.startswith("INFO:")]
        print("\n\033[36m▸ CONSOLE\033[0m")
        ok("live page has no console errors", not real, "; ".join(real[:2]))

        await pg.bring_to_front()
        await pg.click('.rail-btn[data-view="live"]')
        await pg.wait_for_timeout(900)
        await pg.screenshot(path="screenshots/30-aura-live.png")
        await b.close()
    print(f"\n  \033[32mPASS {len(P)}\033[0m  FAIL {len(F)}")
    if F: print("  Failed: " + ", ".join(F)); sys.exit(1)
asyncio.run(main())
