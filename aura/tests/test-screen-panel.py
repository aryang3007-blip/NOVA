import asyncio, sys
from playwright.async_api import async_playwright
PORT = sys.argv[1] if len(sys.argv)>1 else "8071"
P=[];F=[]
def ok(n,c,d=""):
    (P if c else F).append(n)
    print(("  \033[32m✓\033[0m " if c else "  \033[31m✗\033[0m ")+n+(f"  \033[90m{d}\033[0m" if d else ""))
async def main():
    async with async_playwright() as pw:
        b=await pw.chromium.launch(args=["--enable-unsafe-swiftshader","--no-sandbox",
            "--auto-accept-this-tab-capture","--auto-select-desktop-capture-source=Entire screen",
            "--use-fake-ui-for-media-stream","--use-fake-device-for-media-stream"])
        pg=await (await b.new_context(permissions=["camera"],viewport={"width":1500,"height":950})).new_page()
        errs=[]
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("console", lambda m: errs.append(m.text) if m.type=="error" and not m.text.startswith("INFO:") else None)
        await pg.goto(f"http://127.0.0.1:{PORT}/", wait_until="load"); await pg.wait_for_timeout(7000)
        try: await pg.click("#boot-go", timeout=4000)
        except Exception:
            try: await pg.click("text=INITIALIZE", timeout=4000)
            except Exception: pass
        await pg.wait_for_timeout(6000)

        # v0.17 moved screen control OUT of the right-hand panel stack and onto
        # its own full page at /screen (AURA Live). The old in-panel preview was
        # deliberately deleted rather than left as dead buttons. This suite was
        # never updated and had been asserting the removed panel still existed.
        # It now checks the CURRENT shape: a dock link to /screen, no stale
        # panel, and the trace log still mounted in the main app.
        print("\n\033[36m▸ SCREEN CONTROL LIVES AT /screen\033[0m")
        panel = await pg.evaluate("""() => ({
            liveLink: !!document.querySelector('a[href="/screen"]'),
            noStalePanel: !document.querySelector('section[data-panel="screen"]'),
            noStaleCanvas: !document.getElementById('scr-preview'),
            trace: !!document.getElementById('trace-log'),
            traceDock: !!document.getElementById('trace-dock'),
        })""")
        ok("dock links to AURA Live", panel["liveLink"])
        ok("the removed screen panel is really gone", panel["noStalePanel"])
        ok("no orphaned preview canvas", panel["noStaleCanvas"])
        ok("trace log still mounted", panel["trace"])
        ok("trace log sits in its own dock", panel["traceDock"])

        print("\n\033[36m▸ AURA CURSOR ON A SHARED SCREEN\033[0m")
        cur = await pg.evaluate("""async () => {
            const { screenShare } = await import('/js/vision/screen-share.js');
            const r = await screenShare.start();
            const app = window.AURA;
            const c = app.screenCursor;
            const mv = c.moveTo(640, 360, { label: 'Save' });
            return { started: r.ok, surface: screenShare.surface,
                     mv, visible: c.visible, pt: c.toScreenPoint() };
        }""")
        ok("sharing started", cur["started"])
        ok("AURA cursor placed", cur["mv"]["ok"] and cur["visible"], str(cur["mv"]))
        ok("maps to desktop on a monitor share", cur["pt"]["ok"], str(cur["pt"]))

        # The reticle now renders on the AURA Live page. Draw it through the
        # same ScreenCursor.draw() the page uses and prove it puts down ink.
        drew = await pg.evaluate("""async () => {
            const app = window.AURA;
            const cv = document.createElement('canvas');
            cv.width = 640; cv.height = 360;
            const ctx = cv.getContext('2d');
            ctx.clearRect(0, 0, 640, 360);
            let before = 0;
            let d = ctx.getImageData(0,0,640,360).data;
            for (let i=3;i<d.length;i+=4) if (d[i] > 12) before++;
            app.screenCursor.moveTo(640, 360, { label: 'Save' });
            app.screenCursor.draw(ctx, 640, 360);
            let after = 0;
            d = ctx.getImageData(0,0,640,360).data;
            for (let i=3;i<d.length;i+=4) if (d[i] > 12) after++;
            return { w: cv.width, h: cv.height, before, after };
        }""")
        ok("canvas starts empty", drew["before"] == 0, str(drew["before"]))
        ok("the reticle really draws", drew["after"] > 200, f"{drew['after']} px")

        print("\n\033[36m▸ /find PLACES THE CURSOR (the reported failure)\033[0m")
        find = await pg.evaluate("""async () => {
            const { plugins } = await import('/js/core/plugins.js');
            const app = window.AURA;
            app.screenCursor.hide();
            const r = await plugins.run('/find Save');
            return { out: (r.output||'').slice(0,200),
                     visible: app.screenCursor.visible,
                     x: app.screenCursor.x, y: app.screenCursor.y,
                     label: app.screenCursor.label };
        }""")
        ok("/find placed AURA's cursor", find["visible"], f"({find['x']},{find['y']}) '{find['label']}'")
        ok("and reported the cell", "cell" in find["out"].lower(), find["out"][:90])

        print("\n\033[36m▸ TRACE IS VISIBLE\033[0m")
        tr = await pg.evaluate("""() => {
            const log = document.getElementById('trace-log');
            const steps = [...document.querySelectorAll('.trace-step .trace-label')].map(e=>e.textContent);
            return { hidden: log.hidden, panels: document.querySelectorAll('.trace').length, steps };
        }""")
        ok("trace log is shown", not tr["hidden"])
        ok("a trace panel was created", tr["panels"]>0, f"{tr['panels']} panels")
        ok("steps are listed", len(tr["steps"])>=3, str(tr["steps"][:5]))
        ok("shows the capture step", any("Capture" in s for s in tr["steps"]), str(tr["steps"][:6]))
        ok("shows which model read it", any("reader" in s.lower() or "Model" in s for s in tr["steps"]), str(tr["steps"]))

        print("\n\033[36m▸ WINDOW SHARE STILL GETS A CURSOR\033[0m")
        win = await pg.evaluate("""async () => {
            const { screenShare } = await import('/js/vision/screen-share.js');
            const app = window.AURA;
            const real = screenShare.surface;
            screenShare.surface = 'window';
            const mv = app.screenCursor.moveTo(300, 200, { label: 'Send' });
            const pt = app.screenCursor.toScreenPoint();
            screenShare.surface = real;
            return { mv, pt, visible: app.screenCursor.visible };
        }""")
        ok("cursor works on a window share", win["mv"]["ok"] and win["visible"])
        ok("but clicking is refused", not win["pt"]["ok"], str(win["pt"])[:80])

        print("\n\033[36m▸ NEW GESTURES REGISTERED\033[0m")
        g = await pg.evaluate("""() => {
            const list = window.AURA.gestures.list();
            return { list, panels: window.AURA.visiblePanels() };
        }""")
        for want in ["three","swipe_left","swipe_right","swipe_up","swipe_down"]:
            ok(f"{want} bound to an action", want in g["list"])
        ok("rock is still bound (user relies on it)", "rock" in g["list"])
        ok("swipe cycles real panels", len(g["panels"])>=4, str(g["panels"]))
        ok("hidden page excluded from swiping", "innovations" not in g["panels"], str(g["panels"]))

        cyc = await pg.evaluate("""() => {
            const app = window.AURA;
            app.openPanel('chat');
            const seen = [];
            for (let i=0;i<4;i++){ app.gestures._cyclePanel(1); seen.push(app.currentPanel); }
            return seen;
        }""")
        ok("swipe right moves through panels", len(set(cyc))>=3, str(cyc))

        settings = await pg.evaluate("""() => {
            const app = window.AURA;
            app.closeSettings();
            const before = app.settingsOpen();
            app.gestures.bindings.get('three')({ gesture:'three', confidence:0.9 });
            const after = app.settingsOpen();
            app.closeSettings();
            return { before, after };
        }""")
        ok("three fingers opens settings", not settings["before"] and settings["after"], str(settings))

        print("\n\033[36m▸ /here COMMAND\033[0m")
        here = await pg.evaluate("""async () => {
            const { plugins } = await import('/js/core/plugins.js');
            const names = plugins.listCommands().map(c=>c.name);
            window.AURA.screenCursor.hide();
            const r = await plugins.run('/here');
            return { has: names.includes('here'), out: (r.output||'').slice(0,90) };
        }""")
        ok("/here exists", here["has"])
        ok("/here refuses with no reticle placed", "not placed" in here["out"].lower(), here["out"][:70])

        real=[e for e in errs if "favicon" not in e.lower() and "swiftshader" not in e.lower() and not e.startswith("INFO:")]
        print("\n\033[36m▸ CONSOLE\033[0m")
        ok("no console errors", not real, "; ".join(real[:3]))
        await pg.screenshot(path="screenshots/25-screen-panel.png")
        await b.close()
    print(f"\n  \033[32mPASS {len(P)}\033[0m  FAIL {len(F)}")
    if F: print("  Failed: "+", ".join(F)); sys.exit(1)
asyncio.run(main())
