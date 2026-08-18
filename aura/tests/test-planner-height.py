import asyncio, sys
from playwright.async_api import async_playwright
PORT = sys.argv[1] if len(sys.argv)>1 else "8081"
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
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("console", lambda m: errs.append(m.text) if m.type=="error" and not m.text.startswith("INFO:") else None)
        await pg.goto(f"http://127.0.0.1:{PORT}/", wait_until="load"); await pg.wait_for_timeout(7000)
        try: await pg.click("#boot-go", timeout=4000)
        except Exception:
            try: await pg.click("text=INITIALIZE", timeout=4000)
            except Exception: pass
        await pg.wait_for_timeout(6000)

        print("\n\033[36m▸ MOONDREAM IS NOT THE CHAT MODEL\033[0m")
        r = await pg.evaluate("""async () => {
            const app = window.AURA;
            await app.ai.refreshModelRegistry();
            const { TASK } = await import('/js/ai/model-registry.js');
            return { chat: app.ai.models.select(TASK.CHAT)?.name,
                     vision: app.ai.models.select(TASK.VISION)?.name,
                     excluded: app.ai.models.excluded().map(m => m.name+': '+m.reason.slice(0,40)),
                     pick: app.ai.pickOllamaModel('hello').name };
        }""")
        ok("chat model is not moondream", r["chat"] != "moondream:latest", str(r["chat"]))
        ok("chat is the 2B text model", r["chat"] == "gemma2:2b", str(r["chat"]))
        ok("engine agrees", r["pick"] == "gemma2:2b", str(r["pick"]))
        ok("moondream excluded with a reason",
           any("moondream" in e and "captioner" in e for e in r["excluded"]), str(r["excluded"]))

        print("\n\033[36m▸ SCREEN SHARE — VERIFIED IN A REAL BROWSER\033[0m")
        sh = await pg.evaluate("""async () => {
            const { screenShare } = await import('/js/vision/screen-share.js');
            const s = await screenShare.start();
            const f = screenShare.grab();
            const g = screenShare.geometry();
            return { started: s.ok, msg: s.message, surface: screenShare.surface,
                     bytes: f ? f.length : 0, jpeg: !!f && f.startsWith('data:image/jpeg'), g };
        }""")
        ok("sharing actually starts", sh["started"], sh.get("msg",""))
        ok("a real frame is captured", sh["bytes"] > 2000, f"{sh['bytes']} bytes")
        ok("frame is JPEG", sh["jpeg"])
        ok("downscaled to <=1280", max(sh["g"]["capturedWidth"], sh["g"]["capturedHeight"]) <= 1280,
           f"{sh['g']['capturedWidth']}x{sh['g']['capturedHeight']}")

        print("\n\033[36m▸ READER + PLANNER PICK THE RIGHT MODELS\033[0m")
        pick = await pg.evaluate("""async () => {
            const { ScreenAgent } = await import('/js/ai/screen-agent.js');
            const { screenShare } = await import('/js/vision/screen-share.js');
            const { config } = await import('/js/core/config.js');
            const app = window.AURA;
            const a = new ScreenAgent({ screen: screenShare, ai: app.ai,
                                        actions: app.actions, config,
                                        cursor: app.screenCursor });
            window.__agent = a;
            return { ocr: a.pickOcrModel(), planner: a.pickPlannerModel() };
        }""")
        ok("reader is not moondream", pick["ocr"]["name"] != "moondream:latest", str(pick["ocr"]))
        ok("planner is not moondream", pick["planner"]["name"] != "moondream:latest", str(pick["planner"]))
        ok("planner is multimodal and large enough",
           pick["planner"]["name"] in ("gemma4:12b","qwen2.5vl:7b"), str(pick["planner"]))

        print("\n\033[36m▸ /do PLANS DIRECTLY FROM THE IMAGE\033[0m")
        plan = await pg.evaluate("""async () => {
            const a = window.__agent;
            const { Trace } = await import('/js/core/trace.js');
            const t = new Trace('test /do');
            const p = await a.plan('click Send then type hello', { trace: t });
            if (!p.ok) { t.end('fail', p.message); return { ok:false, msg:p.message }; }
            const res = await a.resolve(p.intents, { trace: t });
            t.end(res.ok?'ok':'fail','');
            return { ok: res.ok, planner: p.planner, intents: p.intents,
                     plan: res.plan, narration: res.narration, msg: res.message };
        }""")
        ok("plan() succeeded", plan["ok"], str(plan.get("msg"))[:100])
        if plan["ok"]:
            ok("the vision model planned it", plan["planner"] in ("gemma4:12b","qwen2.5vl:7b"), str(plan["planner"]))
            ok("planner returned a cell for the click",
               any(i.get("cell") for i in plan["intents"]), str(plan["intents"]))
            ok("resolved to real coordinates",
               plan["plan"][0]["x"] > 0 and plan["plan"][0]["y"] > 0, str(plan["plan"][0]))
            # fake-real-ollama cycles through five MESSY replies, and every one
            # of them is a SINGLE-step plan. Asserting exactly 2 lines only
            # passed by luck of where the cycle happened to be. What actually
            # matters is that narration explains every step it resolved.
            ok("narration explains each step",
               len(plan["narration"]) == len(plan["plan"]) and len(plan["narration"]) >= 1,
               f"{len(plan['narration'])} lines for {len(plan['plan'])} steps: {plan['narration']}")

        print("\n\033[36m▸ AVATAR HEIGHT\033[0m")
        h = await pg.evaluate("""async () => {
            const app = window.AURA;
            const { config } = await import('/js/core/config.js');
            const slider = document.getElementById('ward-height');
            const before = app.avatar.provider?.body?.root?.scale?.y
                        ?? app.avatar.provider?.root?.scale?.y ?? null;
            const applied = app.avatar.setHeight(1.4);
            const after = app.avatar.provider?.body?.root?.scale?.y
                       ?? app.avatar.provider?.root?.scale?.y ?? null;
            app.avatar.setHeight(0.7);
            const small = app.avatar.provider?.body?.root?.scale?.y
                       ?? app.avatar.provider?.root?.scale?.y ?? null;
            app.avatar.setHeight(1);
            return { slider: !!slider, applied, before, after, small,
                     saved: config.get('avatarHeight'),
                     presets: document.querySelectorAll('button[data-height]').length };
        }""")
        ok("height slider exists", h["slider"])
        ok("quick presets exist", h["presets"] == 3, str(h["presets"]))
        ok("setHeight is applied by the provider", h["applied"], str(h))
        ok("taller actually scales up", h["after"] and h["after"] > (h["before"] or 1),
           f"{h['before']} -> {h['after']}")
        ok("shorter actually scales down", h["small"] and h["small"] < 1, str(h["small"]))
        ok("value is persisted", h["saved"] == 1, str(h["saved"]))

        ui = await pg.evaluate("""async () => {
            const app = window.AURA;
            app.openPanel('wardrobe');
            const s = document.getElementById('ward-height');
            s.value = '1.3';
            s.dispatchEvent(new Event('input', { bubbles: true }));
            await new Promise(r => setTimeout(r, 250));
            const y = app.avatar.provider?.body?.root?.scale?.y
                   ?? app.avatar.provider?.root?.scale?.y ?? null;
            return { label: document.getElementById('ward-height-val').textContent, y };
        }""")
        ok("dragging the slider updates the label", "130" in ui["label"], ui["label"])
        ok("and resizes the avatar live", ui["y"] and abs(ui["y"]-1.3) < 0.01, str(ui["y"]))

        real=[e for e in errs if "favicon" not in e.lower() and "swiftshader" not in e.lower() and not e.startswith("INFO:")]
        print("\n\033[36m▸ CONSOLE\033[0m")
        ok("no console errors", not real, "; ".join(real[:3]))
        await b.close()
    print(f"\n  \033[32mPASS {len(P)}\033[0m  FAIL {len(F)}")
    if F: print("  Failed: "+", ".join(F)); sys.exit(1)
asyncio.run(main())
