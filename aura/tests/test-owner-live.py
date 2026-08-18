"""
AURA :: Privacy Guard owner rules + AURA Live toggle
====================================================
Regression for the user-reported failure: "even when no one was behind me,
when I showed it my own face it minimized."

    cp tests/fake-pyautogui.py /tmp/pyautogui.py
    PYTHONPATH=/tmp python3 serve.py 8161 --allow-actions &
    python3 tests/test-owner-live.py 8161
"""
import asyncio, sys, json
from playwright.async_api import async_playwright
PORT = sys.argv[1] if len(sys.argv)>1 else "8161"
P=[];F=[]
def ok(n,c,d=""):
    (P if c else F).append(n)
    print(("  \033[32m✓\033[0m " if c else "  \033[31m✗\033[0m ")+n+(f"  \033[90m{d}\033[0m" if d else ""))
async def main():
    async with async_playwright() as pw:
        b=await pw.chromium.launch(args=["--enable-unsafe-swiftshader","--no-sandbox",
            "--use-fake-ui-for-media-stream","--use-fake-device-for-media-stream"])
        pg=await (await b.new_context(permissions=["camera"],viewport={"width":1500,"height":980})).new_page()
        errs=[]
        pg.on("pageerror", lambda e: errs.append("PAGEERROR: "+str(e)))
        pg.on("console", lambda m: errs.append(m.text)
              if m.type=="error" and not m.text.startswith("INFO:") else None)
        pg.on("dialog", lambda d: asyncio.ensure_future(d.accept()))
        await pg.goto(f"http://127.0.0.1:{PORT}/", wait_until="load"); await pg.wait_for_timeout(7000)
        try: await pg.click("#boot-go", timeout=4000)
        except Exception:
            try: await pg.click("text=INITIALIZE", timeout=4000)
            except Exception: pass
        await pg.wait_for_timeout(5000)
        for sel in ["text=Skip — use offline core", "#setup-skip"]:
            try: await pg.click(sel, timeout=1500); break
            except Exception: pass
        await pg.wait_for_timeout(1000)

        print("\n\033[36m▸ OWNER RULES IN THE REAL APP\033[0m")
        d = await pg.evaluate("""() => {
            const s = window.AURA.privacyGuard.status();
            return { minFaces: s.minFaces, owner: s.neverIfOwnerAlone,
                     ui: !!document.getElementById('pg-minfaces'),
                     ownerToggle: !!document.getElementById('pg-owner'),
                     manage: !!document.getElementById('pg-manage-faces') };
        }""")
        ok("minFaces defaults to 2", d["minFaces"] == 2, str(d["minFaces"]))
        ok("owner protection on by default", d["owner"] is True)
        ok("minFaces slider in the UI", d["ui"])
        ok("owner toggle in the UI", d["ownerToggle"])
        ok("link to face enrolment", d["manage"])

        r = await pg.evaluate("""async () => {
            const { bus, EV } = await import('/js/core/bus.js');
            const g = window.AURA.privacyGuard;
            document.getElementById('pg-enable').click();
            await new Promise(r=>setTimeout(r,600));
            g.configure({ detectionPersistenceMs: 150, cooldownMs: 2000 });
            g.opts.ignoreOwnFaceMs = 0;
            const ev = o => ({ type:'person_detected', present:true, count:o.faceCount,
                               confidence:0.95, area:0.09, source:'face',
                               timestamp:Date.now(), ...o });
            // 1. Owner alone — the reported failure.
            g._cooldownUntil = 0; g._since = 0;
            let before = g.stats.triggers;
            for (let i=0;i<8;i++) bus.emit(EV.PRESENCE, ev({faceCount:1, knownNames:['Aryan']}));
            await new Promise(r=>setTimeout(r,400));
            for (let i=0;i<8;i++) bus.emit(EV.PRESENCE, ev({faceCount:1, knownNames:['Aryan']}));
            await new Promise(r=>setTimeout(r,300));
            const ownerAlone = g.stats.triggers - before;
            const veto = g.status().lastVeto;
            // 2. Owner + stranger.
            g._cooldownUntil = 0; g._since = 0;
            before = g.stats.triggers;
            bus.emit(EV.PRESENCE, ev({faceCount:2, knownNames:['Aryan']}));
            await new Promise(r=>setTimeout(r,260));
            bus.emit(EV.PRESENCE, ev({faceCount:2, knownNames:['Aryan']}));
            await new Promise(r=>setTimeout(r,900));
            const withStranger = g.stats.triggers - before;
            return { ownerAlone, withStranger, veto, vetoed: g.stats.vetoed,
                     uiVeto: document.getElementById('pg-veto')?.textContent || '' };
        }""")
        ok("OWNER ALONE never minimises", r["ownerAlone"] == 0, str(r["ownerAlone"]))
        ok("and the reason is shown", "1 face" in (r["veto"] or ""), str(r["veto"]))
        ok("owner + STRANGER does minimise", r["withStranger"] == 1, str(r["withStranger"]))
        ok("vetoes are counted", r["vetoed"] > 0, str(r["vetoed"]))

        print("\n\033[36m▸ AURA LIVE TOGGLE — HIDE, NOT DELETE\033[0m")
        lv = await pg.evaluate("""async () => {
            const el = document.getElementById('tg-auralive');
            const before = { visible: !document.getElementById('dock-live')?.hidden };
            el.click();
            await new Promise(r=>setTimeout(r,400));
            const { config } = await import('/js/core/config.js');
            const off = { visible: !document.getElementById('dock-live')?.hidden,
                          cfg: config.get('auraLiveEnabled'),
                          badge: document.getElementById('live-badge')?.textContent };
            el.click();
            await new Promise(r=>setTimeout(r,400));
            const on = { visible: !document.getElementById('dock-live')?.hidden,
                         cfg: config.get('auraLiveEnabled') };
            return { before, off, on };
        }""")
        ok("visible by default", lv["before"]["visible"])
        ok("hiding removes the dock entry", lv["off"]["visible"] is False)
        ok("preference is stored", lv["off"]["cfg"] is False, str(lv["off"]["cfg"]))
        ok("badge shows HIDDEN", lv["off"]["badge"] == "HIDDEN", str(lv["off"]["badge"]))
        ok("re-enabling restores it", lv["on"]["visible"] is True)

        route = await pg.evaluate(f"""async () => {{
            const r = await fetch('/screen', {{ cache: 'no-store' }});
            return {{ status: r.status, len: (await r.text()).length }};
        }}""")
        ok("the /screen route still works when hidden", route["status"] == 200, str(route["status"]))
        ok("the page is intact, not stubbed", route["len"] > 3000, f"{route['len']} bytes")

        print("\n\033[36m▸ NOTHING ELSE BROKE\033[0m")
        keep = await pg.evaluate("""async () => {
            const { plugins } = await import('/js/core/plugins.js');
            const v = window.AURA.vision;
            return { cmds: plugins.listCommands().length,
                     gestures: window.AURA.gestures.list().length,
                     hands: !!v.handLandmarker, faces: !!v.faceLandmarker,
                     avatar: !!window.AURA.avatar, voice: !!window.AURA.voice,
                     kernel: !!window.AURA.kernel };
        }""")
        ok("commands intact", keep["cmds"] >= 65, str(keep["cmds"]))
        ok("gestures intact", keep["gestures"] >= 14, str(keep["gestures"]))
        ok("avatar intact", keep["avatar"])
        ok("voice intact", keep["voice"])
        ok("runtime kernel intact", keep["kernel"])

        real=[e for e in errs if "favicon" not in e.lower() and "swiftshader" not in e.lower()
              and not e.startswith("INFO:")]
        print("\n\033[36m▸ CONSOLE\033[0m")
        ok("no console errors", not real, "; ".join(real[:2]))
        await b.close()
    print(f"\n  \033[32mPASS {len(P)}\033[0m  FAIL {len(F)}")
    if F: print("  Failed: "+", ".join(F)); sys.exit(1)
asyncio.run(main())
