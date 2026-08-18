"""
AURA :: /do planning pipeline
=============================
Runs against tests/fake-real-ollama.py, which returns the MESSY replies real
7B models actually produce — prose wrappers, single quotes, trailing commas,
unquoted keys, and plain English with no JSON at all.

If /do only survives pristine JSON, /do does not work. That was the bug.

    python3 tests/fake-real-ollama.py &
    python3 serve.py 8091 --allow-actions &
    python3 tests/test-do-pipeline.py 8091
"""
import asyncio, sys, json
from playwright.async_api import async_playwright
PORT = sys.argv[1] if len(sys.argv)>1 else "8091"
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
        await pg.goto(f"http://127.0.0.1:{PORT}/", wait_until="load"); await pg.wait_for_timeout(7000)
        try: await pg.click("#boot-go", timeout=4000)
        except Exception:
            try: await pg.click("text=INITIALIZE", timeout=4000)
            except Exception: pass
        await pg.wait_for_timeout(6000)
        # auto-accept the /do confirm dialog
        pg.on("dialog", lambda d: asyncio.ensure_future(d.accept()))

        print("\n\033[36m▸ ABORT NO LONGER THROWS (engine.js:586 / 1007)\033[0m")
        ab = await pg.evaluate("""async () => {
            const app = window.AURA;
            const before = [];
            const h = (e) => before.push(String(e.reason));
            window.addEventListener('unhandledrejection', h);
            // Start a stream then immediately supersede it, twice.
            app.send('tell me a long story about the sea');
            await new Promise(r => setTimeout(r, 350));
            app.send('now a different long story');
            await new Promise(r => setTimeout(r, 350));
            app.ai.stop('user');
            await new Promise(r => setTimeout(r, 1500));
            window.removeEventListener('unhandledrejection', h);
            return before;
        }""")
        ok("no unhandled rejection on Stop/supersede", len(ab)==0, str(ab[:2]))

        print("\n\033[36m▸ /do close the open window  (must just work)\033[0m")
        r1 = await pg.evaluate("""async () => {
            const { plugins } = await import('/js/core/plugins.js');
            const app = window.AURA;
            await app.actions.automationArm();
            const t0 = Date.now();
            const r = await plugins.run('/do close the open window');
            return { out: (r.output||r.error||'').slice(0,220), ms: Date.now()-t0 };
        }""")
        ok("runs without a screen share", "Not sharing" not in r1["out"], r1["out"][:110])
        ok("is fast (no model call)", r1["ms"] < 4000, f"{r1['ms']}ms")
        ok("does not fail to parse", "Could not parse" not in r1["out"], r1["out"][:110])

        print("\n\033[36m▸ /do WITH A SHARED SCREEN, MESSY MODEL OUTPUT\033[0m")
        share = await pg.evaluate("""async () => {
            const { screenShare } = await import('/js/vision/screen-share.js');
            const s = await screenShare.start();
            return { ok: s.ok, surface: screenShare.surface };
        }""")
        ok("screen sharing started", share["ok"], str(share))

        # The stub cycles through 5 realistic reply shapes. All must plan.
        for i in range(5):
            res = await pg.evaluate("""async () => {
                const { ScreenAgent } = await import('/js/ai/screen-agent.js');
                const { screenShare } = await import('/js/vision/screen-share.js');
                const { config } = await import('/js/core/config.js');
                const { Trace } = await import('/js/core/trace.js');
                const app = window.AURA;
                const a = new ScreenAgent({ screen: screenShare, ai: app.ai,
                    actions: app.actions, config, cursor: app.screenCursor });
                const t = new Trace('probe');
                const p = await a.plan('click the close button', { trace: t });
                if (!p.ok) { t.end('fail', p.message); return { ok:false, msg:p.message.slice(0,120) }; }
                const rr = await a.resolve(p.intents, { trace: t });
                t.end('ok','');
                return { ok: rr.ok, stage: p.stage, planner: p.planner,
                         salvaged: !!p.salvaged, intents: p.intents,
                         plan: rr.plan, msg: (rr.message||'').slice(0,120) };
            }""")
            ok(f"messy reply #{i+1} produced a plan", res["ok"],
               f"{res.get('stage')} via {res.get('planner')} {json.dumps(res.get('intents'))[:80]}"
               if res["ok"] else res.get("msg",""))

        print("\n\033[36m▸ TWO-STAGE FALLBACK (moondream path)\033[0m")
        two = await pg.evaluate("""async () => {
            const { ScreenAgent } = await import('/js/ai/screen-agent.js');
            const { screenShare } = await import('/js/vision/screen-share.js');
            const { ollama } = await import('/js/ai/providers.js');
            const { Trace } = await import('/js/core/trace.js');
            const app = window.AURA;
            const saved = ollama.installed.slice();
            // Simulate a machine whose ONLY image model is moondream.
            ollama.installed = ['moondream:latest','gemma2:2b'];
            const a = new ScreenAgent({ screen: screenShare, ai: app.ai,
                actions: app.actions, config: null, cursor: app.screenCursor });
            const t = new Trace('two-stage probe');
            const p = await a.plan('click the close button', { trace: t });
            t.end(p.ok?'ok':'fail','');
            ollama.installed = saved;
            return { ok: p.ok, stage: p.stage, describer: p.describer,
                     planner: p.planner, msg: (p.message||'').slice(0,160) };
        }""")
        ok("moondream-only machine still plans", two["ok"], two.get("msg",""))
        if two["ok"]:
            ok("it used the two-stage path", two["stage"]=="two-stage", str(two["stage"]))
            ok("moondream only described", two["describer"]=="moondream:latest", str(two["describer"]))
            ok("a text model did the planning", two["planner"]!="moondream:latest", str(two["planner"]))

        real=[e for e in errs if "favicon" not in e.lower() and "swiftshader" not in e.lower() and not e.startswith("INFO:")]
        print("\n\033[36m▸ CONSOLE\033[0m")
        ok("no console errors", not real, "; ".join(real[:3]))
        await b.close()
    print(f"\n  \033[32mPASS {len(P)}\033[0m  FAIL {len(F)}")
    if F: print("  Failed: "+", ".join(F)); sys.exit(1)
asyncio.run(main())
