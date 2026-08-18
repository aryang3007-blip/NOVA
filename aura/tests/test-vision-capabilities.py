"""
AURA :: vision capability detection, in a real browser
======================================================
Regression guard for the gemma4 bug (see FEATURE_STATUS.md #67/#68).

Needs a running AURA server AND an Ollama exposing /api/show. Start the
reference stub first:

    python3 tests/fake-user-ollama.py &
    python3 serve.py 8042 --allow-actions &
    python3 tests/test-vision-capabilities.py 8042
"""
import asyncio, json, sys
from playwright.async_api import async_playwright

PORT = sys.argv[1] if len(sys.argv) > 1 else "8042"
URL = f"http://127.0.0.1:{PORT}/"
PASS=[]; FAIL=[]
def ok(n,c,d=""):
    (PASS if c else FAIL).append(n)
    print(("  \033[32m✓\033[0m " if c else "  \033[31m✗\033[0m ")+n+(f"  \033[90m{d}\033[0m" if d else ""))

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=[
            "--use-fake-ui-for-media-stream","--use-fake-device-for-media-stream",
            "--enable-unsafe-swiftshader","--no-sandbox"])
        ctx = await b.new_context(permissions=["camera"])
        pg = await ctx.new_page()
        errs=[]
        pg.on("console", lambda m: errs.append(m.text) if m.type=="error" else None)
        pg.on("pageerror", lambda e: errs.append(str(e)))
        await pg.goto(URL, wait_until="load")
        await pg.wait_for_timeout(9000)

        # ── capabilities reached the browser
        caps = await pg.evaluate("""async () => {
            const m = await import('/js/ai/providers.js');
            await m.ollama.refresh({force:true});
            return { installed: m.ollama.installed, caps: m.ollama.caps,
                     vision: m.ollama.visionModels(),
                     g4real: m.ollama.capsAreReal('gemma4:12b'),
                     g4vis: m.ollama.isVisionModel('gemma4:12b'),
                     report: m.ollama.capabilityReport() };
        }""")
        print("\n\033[36m▸ CAPABILITIES IN THE BROWSER\033[0m")
        ok("8 models discovered", len(caps["installed"])==8, str(len(caps["installed"])))
        ok("gemma4:12b flagged vision", caps["g4vis"] is True)
        ok("gemma4 capabilities are VERIFIED not guessed", caps["g4real"] is True)
        ok("vision roster = gemma4 + qwen2.5vl",
           sorted(caps["vision"])==["gemma4:12b","qwen2.5vl:7b"], str(caps["vision"]))
        ok("every model reports source=ollama",
           all(r["source"]=="ollama" for r in caps["report"]),
           str([r["source"] for r in caps["report"]]))

        # ── which model does /look actually choose?
        pick = await pg.evaluate("""async () => {
            const app = window.AURA || window.aura || {};
            const ai = app.ai || app.engine;
            if (!ai) return {err:'no engine on window'};
            await ai.refreshModelRegistry();
            const p = ai.pickVisionModel ? ai.pickVisionModel() : null;
            return { pick: p, chat: ai.pickOllamaModel('hello').name };
        }""")
        print("\n\033[36m▸ /look MODEL SELECTION\033[0m")
        if pick.get("err"):
            ok("engine reachable", False, pick["err"])
        else:
            ok("a vision model is chosen", bool(pick["pick"]), json.dumps(pick["pick"]))
            ok("picks the 7B, not a 12B", pick["pick"]["name"]=="qwen2.5vl:7b", pick["pick"]["name"])
            ok("reason is explanatory", len(pick["pick"]["reason"])>5, pick["pick"]["reason"])
            ok("normal chat still routes to gemma2:2b", pick["chat"]=="gemma2:2b", pick["chat"])

        # ── end-to-end: camera on, /look, image really reaches the model
        print("\n\033[36m▸ END-TO-END /look\033[0m")
        await pg.evaluate("""async () => {
            const app = window.AURA;
            if (app?.enableVision) await app.enableVision();
            else if (app?.ui?.enableVision) await app.ui.enableVision();
        }""")
        await pg.wait_for_timeout(6000)
        cam = await pg.evaluate("""async () => {
            const { state } = await import('/js/core/state.js');
            return !!state.get('cameraActive');
        }""")
        ok("camera active", bool(cam), str(cam))

        out = await pg.evaluate("""async () => {
            const app = window.AURA;
            const { plugins } = await import('/js/core/plugins.js');
            const before = app.ai.memory.all().length;
            await plugins.run('/look what do you see?');
            await new Promise(r => setTimeout(r, 5000));
            const msgs = app.ai.memory.all();
            return { added: msgs.length - before, last: msgs[msgs.length-1]?.content || '' };
        }""")
        ok("/look produced a reply", out["added"]>0, f"+{out['added']} msgs")
        ok("the model actually RECEIVED an image",
           "received 1 image" in out["last"], out["last"][:110])
        ok("the vision model handled it, not a text model",
           "qwen2.5vl:7b" in out["last"] or "gemma4:12b" in out["last"], out["last"][:110])

        real = [e for e in errs if "favicon" not in e.lower()
                and "swiftshader" not in e.lower()
                and not e.startswith("INFO:")]   # MediaPipe XNNPACK notice
        print("\n\033[36m▸ CONSOLE\033[0m")
        ok("no console errors", not real, "; ".join(real[:3]))

        await pg.screenshot(path="/home/user/aura/screenshots/22-vision-capabilities.png")
        await b.close()

    print(f"\n  \033[32mPASS {len(PASS)}\033[0m  FAIL {len(FAIL)}")
    if FAIL:
        print("  Failed: "+", ".join(FAIL))
        sys.exit(1)

asyncio.run(main())
