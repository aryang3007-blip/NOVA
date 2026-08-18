"""
AURA :: Developer Console + Runtime wiring, in a real browser
=============================================================
    cp tests/fake-pyautogui.py /tmp/pyautogui.py
    python3 tests/fake-agent-ollama.py &
    PYTHONPATH=/tmp python3 serve.py 8111 --allow-actions &
    python3 tests/test-devconsole.py 8111
"""
import asyncio, sys, json
from playwright.async_api import async_playwright
PORT = sys.argv[1] if len(sys.argv)>1 else "8111"
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

        print("\n\033[36m▸ RUNTIME KERNEL IS WIRED\033[0m")
        w = await pg.evaluate("""() => ({
            kernel: !!window.AURA.kernel,
            world: !!window.AURA.world,
            devConsole: !!window.AURA.devConsole,
            localRuntimeIntact: !!(window.AURA.runtime && window.AURA.runtime.transport !== undefined),
            commands: window.AURA.kernel ? window.AURA.kernel.availability().length : 0,
        })""")
        ok("kernel exists", w["kernel"])
        ok("world model exists", w["world"])
        ok("dev console exists", w["devConsole"])
        ok("LocalRuntime was NOT clobbered", w["localRuntimeIntact"], str(w["localRuntimeIntact"]))
        ok("commands are registered", w["commands"] >= 25, str(w["commands"]))

        print("\n\033[36m▸ GATES ENFORCE IN THE REAL APP\033[0m")
        g = await pg.evaluate("""async () => {
            const k = window.AURA.kernel;
            const invented = await k.execute({ action: 'format_disk' });
            const noPerm = await k.execute({ action: 'open_app', app: 'whatsapp' },
                                           { confirm: async () => true });
            return { invented, noPerm, stats: k.stats };
        }""")
        ok("an invented command is rejected at the registry",
           g["invented"]["stage"] == "registry", str(g["invented"]))
        ok("a real command without permission is rejected",
           not g["noPerm"]["ok"] and g["noPerm"]["stage"] in ("permission","execute"),
           str(g["noPerm"])[:110])
        ok("stats are tracked", g["stats"]["proposed"] >= 2, json.dumps(g["stats"]))

        print("\n\033[36m▸ WORLD MODEL UPDATES\033[0m")
        wm = await pg.evaluate("""async () => {
            const k = window.AURA.kernel;
            window.AURA.desktop.setup.applyRecommended();
            await k.execute({ command: 'desktop.running_apps' });
            const snap = window.AURA.world.snapshot();
            return { available: snap.processes.available, desc: window.AURA.world.describe() };
        }""")
        ok("running_apps populated the world model", wm["available"] is not None, str(wm["available"]))
        ok("describe() produces context", len(wm["desc"]) > 10, wm["desc"][:90])

        print("\n\033[36m▸ DEVELOPER CONSOLE PANEL\033[0m")
        dc = await pg.evaluate("""async () => {
            window.AURA.openPanel('devconsole');
            await new Promise(r => setTimeout(r, 1200));
            return {
                visible: !!document.querySelector('section[data-panel="devconsole"].active'),
                nodes: document.querySelectorAll('.dc-node').length,
                tabs: document.querySelectorAll('.dc-tab').length,
                stats: document.querySelectorAll('.dc-stat').length,
                rows: document.querySelectorAll('#dc-overview .dc-row').length,
            };
        }""")
        ok("panel opens", dc["visible"])
        ok("pipeline diagram renders", dc["nodes"] == 6, str(dc["nodes"]))
        ok("all five tabs exist", dc["tabs"] == 5, str(dc["tabs"]))
        ok("overview stats render", dc["stats"] >= 5, str(dc["stats"]))
        ok("recent dispatches are listed", dc["rows"] > 0, str(dc["rows"]))

        for tab, sel in [("world","#dc-world .dc-pair"), ("commands","#dc-commands .dc-row"),
                         ("events","#dc-events .dc-row"), ("logs","#dc-logs .dc-row")]:
            n = await pg.evaluate(f"""async () => {{
                document.querySelector('.dc-tab[data-dc="{tab}"]').click();
                await new Promise(r => setTimeout(r, 500));
                return document.querySelectorAll('{sel}').length;
            }}""")
            ok(f"{tab} tab renders content", n > 0, f"{n} rows")

        print("\n\033[36m▸ EVENT CAPTURE + PAUSE\033[0m")
        ev = await pg.evaluate("""async () => {
            const { bus } = await import('/js/core/bus.js');
            const dcv = window.AURA.devConsole;
            const before = dcv.events.length;
            bus.emit('test:probe', { hello: 'world' });
            const after = dcv.events.length;
            const captured = dcv.events[dcv.events.length-1];
            document.getElementById('dc-pause').click();
            const paused = dcv.paused;
            document.getElementById('dc-pause').click();
            return { grew: after > before, name: captured?.event, paused };
        }""")
        ok("the console captures bus events", ev["grew"], str(ev["name"]))
        ok("it records the event name", ev["name"] == "test:probe", str(ev["name"]))
        ok("pause toggles", ev["paused"] is True)

        print("\n\033[36m▸ STREAMS ARE BOUNDED (no leak in a long session)\033[0m")
        bd = await pg.evaluate("""async () => {
            const { bus } = await import('/js/core/bus.js');
            for (let i=0;i<600;i++) bus.emit('test:flood', { i });
            return { events: window.AURA.devConsole.events.length,
                     logs: window.AURA.devConsole.logs.length };
        }""")
        ok("event buffer is capped", bd["events"] <= 300, str(bd["events"]))
        ok("log buffer is capped", bd["logs"] <= 300, str(bd["logs"]))

        print("\n\033[36m▸ NOTHING EXISTING BROKE\033[0m")
        keep = await pg.evaluate("""async () => {
            const { plugins } = await import('/js/core/plugins.js');
            const names = plugins.listCommands().map(c=>c.name);
            return {
                cmds: names.length,
                has: ['task','do','watch','look','automation','models','help'].filter(n=>names.includes(n)),
                panels: window.AURA.visiblePanels(),
                gestures: window.AURA.gestures.list().length,
                avatar: !!window.AURA.avatar,
                voice: !!window.AURA.voice,
            };
        }""")
        ok("all key commands still present", len(keep["has"]) == 7, str(keep["has"]))
        ok("command count is healthy", keep["cmds"] >= 60, str(keep["cmds"]))
        ok("dev panel joined the dock", "devconsole" in keep["panels"], str(keep["panels"]))
        ok("gestures still bound", keep["gestures"] >= 10, str(keep["gestures"]))
        ok("avatar still present", keep["avatar"])
        ok("voice still present", keep["voice"])

        real=[e for e in errs if "favicon" not in e.lower() and "swiftshader" not in e.lower() and not e.startswith("INFO:")]
        print("\n\033[36m▸ CONSOLE\033[0m")
        ok("no console errors", not real, "; ".join(real[:2]))
        await pg.screenshot(path="screenshots/28-dev-console.png")
        await b.close()
    print(f"\n  \033[32mPASS {len(P)}\033[0m  FAIL {len(F)}")
    if F: print("  Failed: "+", ".join(F)); sys.exit(1)
asyncio.run(main())
