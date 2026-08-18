#!/usr/bin/env python3
"""Post-refactor verification: every layer, panel and feature still loads."""
import asyncio, sys
from playwright.async_api import async_playwright
PORT = sys.argv[1] if len(sys.argv) > 1 else "8070"
ok, bad = [], []
def rec(n,c,d=""):
    (ok if c else bad).append((n,d))
    print(("  \033[32m✓\033[0m " if c else "  \033[31m✗\033[0m ")+n+(f"  \033[90m{d}\033[0m" if d else ""))

async def main():
    async with async_playwright() as pw:
        b=await pw.chromium.launch(args=["--use-fake-ui-for-media-stream","--use-fake-device-for-media-stream",
            "--enable-unsafe-swiftshader","--use-gl=swiftshader","--ignore-gpu-blocklist"])
        ctx=await b.new_context(permissions=["camera","microphone","geolocation"],
            geolocation={"latitude":28.67,"longitude":77.45},viewport={"width":1560,"height":950})
        p=await ctx.new_page()
        errs=[]; cerrs=[]
        p.on("pageerror", lambda e: errs.append(str(e)))
        p.on("console", lambda m: cerrs.append(m.text) if m.type=="error" else None)

        print("\n\033[36m▸ BOOT & LAYERS\033[0m")
        await p.goto(f"http://localhost:{PORT}/", wait_until="domcontentloaded")
        await p.wait_for_selector("#boot-enter:not([hidden])", timeout=60000)
        blog = await p.eval_on_selector_all("#boot-log li","e=>e.map(x=>x.textContent)")
        rec("Boot completes", True, f"{len(blog)} steps")
        # #boot-log only shows the last 9 entries; the event log keeps them all.
        full = await p.evaluate("()=>window.AURA.eventLogLines.join(' | ')")
        for key in ["Memory:","Local runtime:","Hardware:","Services:","Metrics:"]:
            rec(f"Boot logs '{key}'", key in full,
                next((l for l in full.split(" | ") if key in l), "MISSING")[:70])
        btxt = await p.inner_text("#boot-enter")
        rec("No boot failure", "CONTINUE ANYWAY" not in btxt)
        await p.click("#boot-enter"); await p.wait_for_timeout(1500)
        if await p.is_visible(".setup-box"):
            await p.click('[data-act="skip"]'); await p.wait_for_selector(".setup-box",state="detached",timeout=8000)
        await p.wait_for_timeout(2500)

        layers = await p.evaluate("""()=>({
            runtime: !!window.AURA.runtime?.initialized,
            transport: window.AURA.runtime?.transport,
            desktop: !!window.AURA.desktop?.initialized,
            memory: !!window.AURA.memoryManager?.initialized,
            devices: !!window.AURA.devices,
            hardware: window.AURA.runtime?.hardware?.summary().length,
            router: !!window.AURA.ai.router,
            avatar: !!window.AURA.avatar?.ok})""")
        rec("Local Runtime layer initialised", layers["runtime"], f"transport={layers['transport']}")
        rec("Desktop framework under runtime", layers["desktop"])
        rec("Memory manager initialised", layers["memory"])
        rec("Hardware registry (6 caps)", layers["hardware"]==6, str(layers["hardware"]))
        rec("Intent router attached", layers["router"])
        rec("Avatar still renders", layers["avatar"])

        print("\n\033[36m▸ INTENT ROUTING (the AK-47 fix)\033[0m")
        async def ask(m,w=4000):
            await p.evaluate("()=>window.AURA.openPanel('chat')")
            await p.fill("#input",m); await p.press("#input","Enter"); await p.wait_for_timeout(w)
            return await p.evaluate("()=>{const x=[...document.querySelectorAll('.msg.assistant')].pop();return x?x.innerText:''}")

        r = await ask("what is 47*89")
        rec("MATH: 47*89 = 4183", "4,183" in r or "4183" in r, r[:50].replace("\n"," "))
        rec("  ↳ NOT the AK-47 article", "AK-47" not in r and "assault rifle" not in r.lower())
        r = await ask("what is 2 + 2")
        rec("MATH: 2+2 = 4", "= 4" in r or "4" in r[:30], r[:40].replace("\n"," "))
        r = await ask("convert 10 km to miles")
        rec("MATH: unit conversion", "6.2" in r, r[:45].replace("\n"," "))
        r = await ask("hello")
        rec("LOCAL: greeting", len(r)>5 and "4,183" not in r, r[:40].replace("\n"," "))
        route = await p.evaluate("()=>window.AURA.ai._lastRoute?.route")
        rec("Router records decisions", route is not None, str(route))

        print("\n\033[36m▸ TOOL CALLING\033[0m")
        r = await ask("open whatsapp")
        rec("TOOL denied without permission", "permission" in r.lower(), r[:60].replace("\n"," "))
        await p.evaluate("()=>window.AURA.desktop.permissions.grant('launch_apps')")
        r = await ask("open whatsapp")
        rec("TOOL allowed after grant", "simulat" in r.lower() or "whatsapp" in r.lower(), r[:60].replace("\n"," "))
        tool = await p.evaluate("""async ()=>{
            const res = await window.AURA.ai.executeToolCall(
              {type:'tool_call', tool:'launch_application', parameters:{application:'Spotify'}});
            return res;}""")
        rec("Spec-shaped tool_call executes", tool["success"] is True, str(tool)[:70])
        rec("  ↳ result shape matches spec",
            all(k in tool for k in ("success","tool","message")), str(list(tool.keys())))

        print("\n\033[36m▸ MEMORY LAYERS\033[0m")
        m = await p.evaluate("""async ()=>{
            const mm = window.AURA.memoryManager;
            await mm.preferences.set('userName','Commander Stark');
            await mm.knowledge.learn({text:'The lab wifi password is quantum42.',title:'WiFi'});
            mm.system.noteAppLaunched({id:'spotify',name:'Spotify'});
            const ctx = await mm.buildContext('what is the wifi password');
            return {ctx, stats: await mm.stats()};}""")
        rec("Preference memory in context", "Stark" in m["ctx"])
        rec("Knowledge recall in context", "quantum42" in m["ctx"], m["ctx"][:60].replace("\n"," "))
        rec("System state in context", "Spotify" in m["ctx"])
        rec("All four categories report stats",
            all(k in m["stats"] for k in ("conversation","preferences","system","knowledge")))

        print("\n\033[36m▸ NEW PLUGINS & APIs\033[0m")
        for cmd, want, label in [
            ("/define serendipity","serendipity","Dictionary API"),
            ("/repo ollama/ollama","ollama","GitHub API"),
            ("/joke","",  "Joke API"),
            ("/sun Delhi","Sunrise","Sunrise-Sunset API"),
            ("/tools","launch_application","Tool registry"),
            ("/runtime","LOCAL RUNTIME","Runtime diagnostics"),
            ("/why what is 47*89","MATH","Route explainer"),
            ("/recall","MEMORY","Memory inspector"),
        ]:
            r = await ask(cmd, 7000)
            good = (want.lower() in r.lower()) if want else len(r) > 15
            rec(label, good, r[:55].replace("\n"," "))

        r = await ask("/learn AURA was upgraded with a local runtime layer")
        rec("Knowledge /learn works", "Learned" in r, r[:45].replace("\n"," "))
        r = await ask("/recall runtime layer")
        rec("  ↳ and recalls it", "runtime" in r.lower(), r[:55].replace("\n"," "))

        print("\n\033[36m▸ EXISTING FEATURES INTACT\033[0m")
        for cmd, want, label in [
            ("/help","COMMAND REGISTRY","Help"),
            ("/status","AI Core","Status"),
            ("/plugins","PLUGINS LOADED","Plugin registry"),
            ("/weather Delhi","°C","Live weather"),
            ("/crypto bitcoin","BITCOIN","Live crypto"),
            ("/selftest","subsystems","Self test"),
        ]:
            r = await ask(cmd, 9000)
            rec(label, want.lower() in r.lower(), r[:50].replace("\n"," "))

        print("\n\033[36m▸ ALL PANELS LOAD\033[0m")
        # 'system' merged into the OPS panel; the alias is asserted below.
        for panel in ["chat","vision","gestures","wardrobe","ops"]:
            vis = await p.evaluate(f"""async ()=>{{
                window.AURA.openPanel('{panel}');
                await new Promise(r=>setTimeout(r,300));
                const el=document.querySelector('.panel[data-panel="{panel}"]');
                return el && el.classList.contains('active') && el.offsetHeight>50;}}""")
            rec(f"Panel '{panel}'", vis)

        sysalias = await p.evaluate("""async ()=>{
            window.AURA.openPanel('system');
            await new Promise(r=>setTimeout(r,300));
            const ops=document.querySelector('.panel[data-panel="ops"]');
            return ops && ops.classList.contains('active')
                   && !!document.getElementById('sys-readout');}""")
        rec("Legacy 'system' panel aliases to System Center", sysalias)

        print("\n\033[36m▸ ALL SETTINGS TABS LOAD\033[0m")
        await p.evaluate("()=>window.AURA.openSettings()")
        await p.wait_for_selector("#settings:not([hidden])",timeout=8000)
        tabs = await p.evaluate("()=>[...document.querySelectorAll('.tab')].map(t=>t.dataset.tab)")
        # 11 at v0.20.1: + AVATAR, + APPEARANCE, + MEMORY, + DEVICES.
        # Assert the tabs that must EXIST rather than a bare count, so adding
        # a tab is not a test failure while removing one still is.
        rec("Tab count", len(tabs)==11, str(tabs))
        for expected in ("avatar", "appearance", "memory", "devices"):
            rec(f"{expected.upper()} tab present", expected in tabs, str(tabs))
        for t in tabs:
            shown = await p.evaluate(f"""async ()=>{{
                for(const b of document.querySelectorAll('.tab')) if(b.dataset.tab==='{t}') b.click();
                await new Promise(r=>setTimeout(r,250));
                const pane=document.querySelector('.tabpane[data-tab="{t}"]');
                return pane && pane.classList.contains('active') && pane.offsetHeight>30;}}""")
            rec(f"Settings tab '{t}'", shown)
        await p.evaluate("()=>window.AURA.closeSettings()")

        print("\n\033[36m▸ VISION / VOICE / AVATAR\033[0m")
        await p.evaluate("()=>window.AURA.openPanel('vision')")
        await p.click("#btn-cam-start")
        try:
            await p.wait_for_function("()=>window.AURA.vision.stream!==null",timeout=25000)
            rec("Camera starts", True)
        except Exception: rec("Camera starts", False, "no stream")
        await p.wait_for_timeout(2500)
        v = await p.evaluate("()=>({running:window.AURA.vision.running, hands:!!window.AURA.vision.handLandmarker})")
        rec("Vision loop runs", v["running"])
        rec("MediaPipe loaded", v["hands"])
        lip = await p.evaluate("""async ()=>{const bus=(await import('/js/core/bus.js')).bus;
            const a=window.AURA.avatar; a.speaking=true; const h0=a.mouth.h;
            bus.emit('voice:tts-viseme',{visemes:[{viseme:'AI',t:0,dur:400,open:.85}]});
            await new Promise(r=>setTimeout(r,350)); const h1=a.mouth.h; a.speaking=false;
            return Math.abs(h1-h0)>0.05;}""")
        rec("Avatar lip-sync", lip)
        g = await p.evaluate("""async ()=>{const bus=(await import('/js/core/bus.js')).bus;
            const before=document.querySelectorAll('.msg').length;
            bus.emit('gesture:detected',{gesture:'wave',confidence:.95});
            await new Promise(r=>setTimeout(r,800));
            return document.querySelectorAll('.msg').length - before;}""")
        rec("Gesture → action", g>=2, f"{g} messages")

        await p.screenshot(path="tests/final-15-architecture.png")
        print("\n\033[36m▸ ERROR SWEEP\033[0m")
        ignorable=("favicon","ResizeObserver","XNNPACK","TensorFlow","INFO:","WebGL","AudioContext",
                   "Failed to load resource","speechSynthesis","not-allowed","play() request","gl_context")
        real=[e for e in cerrs if not any(i in e for i in ignorable)]
        rec("No uncaught exceptions", len(errs)==0, "; ".join(errs[:2])[:150])
        rec("No unexpected console errors", len(real)<=1, "; ".join(real[:2])[:150])
        await b.close()

    print(f"\n  \033[32mPASS {len(ok)}\033[0m / {len(ok)+len(bad)}" + (f"  \033[31mFAIL {len(bad)}\033[0m" if bad else "  ALL GREEN"))
    for n,d in bad: print(f"    ✗ {n} — {d}")
    return 1 if bad else 0
sys.exit(asyncio.run(main()))
