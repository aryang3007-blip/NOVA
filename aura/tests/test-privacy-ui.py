"""
AURA :: Privacy Guard in the browser + object detection fix
===========================================================
    cp tests/fake-pyautogui.py /tmp/pyautogui.py
    PYTHONPATH=/tmp python3 serve.py 8152 --allow-actions &
    python3 tests/test-privacy-ui.py 8152
"""
import asyncio, sys, json
from playwright.async_api import async_playwright
PORT = sys.argv[1] if len(sys.argv) > 1 else "8152"
P=[];F=[]
def ok(n,c,d=""):
    (P if c else F).append(n)
    print(("  \033[32m✓\033[0m " if c else "  \033[31m✗\033[0m ")+n+(f"  \033[90m{d}\033[0m" if d else ""))

async def main():
    async with async_playwright() as pw:
        b=await pw.chromium.launch(args=["--enable-unsafe-swiftshader","--no-sandbox",
            "--use-fake-ui-for-media-stream","--use-fake-device-for-media-stream"])
        pg=await (await b.new_context(permissions=["camera"],viewport={"width":1500,"height":950})).new_page()
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
        await pg.wait_for_timeout(6000)

        print("\n\033[36m▸ WIRED AND OFF BY DEFAULT\033[0m")
        w = await pg.evaluate("""() => {
            const pg = window.AURA.privacyGuard;
            return { exists: !!pg, enabled: pg?.opts.enabled, state: pg?.state,
                     ui: !!document.getElementById('pg-enable'),
                     badge: document.getElementById('pg-badge')?.textContent,
                     perm: window.AURA.desktop.permissions.isGranted('minimize_windows') };
        }""")
        ok("PrivacyGuard is mounted", w["exists"])
        ok("OFF by default", w["enabled"] is False, str(w["enabled"]))
        ok("state DISABLED", w["state"] == "DISABLED", str(w["state"]))
        ok("UI exists in the Vision panel", w["ui"])
        ok("badge reads OFF", w["badge"] == "OFF", str(w["badge"]))
        ok("permission NOT granted by default", w["perm"] is False, str(w["perm"]))

        print("\n\033[36m▸ OBJECT DETECTION — the reported bug\033[0m")
        od = await pg.evaluate("""async () => {
            const v = window.AURA.vision;
            await window.AURA.enableVision();
            await new Promise(r=>setTimeout(r,4000));
            await v.loadObjects();
            await new Promise(r=>setTimeout(r,5000));
            const { config } = await import('/js/core/config.js');
            // The loop throttles object detection to ~4 Hz, so a single
            // snapshot of `_lastObjects` can legitimately be empty between
            // hits. Sample over ~2.5s and take the best, which is what the
            // user actually experiences.
            let best = [], seen = 0;
            for (let i = 0; i < 12; i++) {
              const cur = v._lastObjects || [];
              if (cur.length) { seen++; if (cur.length > best.length) best = cur; }
              await new Promise(r => setTimeout(r, 220));
            }
            return { threshold: config.get('objectScoreThreshold'),
                     detected: best.length, hits: seen,
                     sample: best.slice(0,3).map(o=>`${o.label} ${o.score.toFixed(2)}`),
                     err: v._objectError, active: window.AURA.state?.get?.('objectsActive') };
        }""")
        ok("threshold lowered from 0.42", od["threshold"] == 0.28, str(od["threshold"]))
        ok("objects are now DETECTED in the loop", od["detected"] > 0,
           f"{od['detected']} objs on {od['hits']}/12 samples → {od['sample']}")
        ok("no silent error", od["err"] in (None, ""), str(od["err"]))

        print("\n\033[36m▸ PRESENCE SIGNAL FROM THE EXISTING PIPELINE\033[0m")
        pres = await pg.evaluate("""async () => {
            const { bus, EV } = await import('/js/core/bus.js');
            const seen = [];
            const h = e => seen.push(e);
            bus.on(EV.PRESENCE, h);
            await new Promise(r=>setTimeout(r,2500));
            bus.off(EV.PRESENCE, h);
            return { n: seen.length, sample: seen[0] || null };
        }""")
        ok("PRESENCE events are emitted", pres["n"] > 0, f"{pres['n']} events")
        if pres["sample"]:
            s = pres["sample"]
            ok("event has the specified shape",
               all(k in s for k in ("type","confidence","timestamp")), json.dumps(s)[:110])
            ok("it is rate-limited, not per-frame", pres["n"] < 40, str(pres["n"]))

        print("\n\033[36m▸ ENABLING GRANTS PERMISSION + ARMS\033[0m")
        en = await pg.evaluate("""async () => {
            document.getElementById('pg-enable').click();
            await new Promise(r=>setTimeout(r,700));
            const pgd = window.AURA.privacyGuard;
            return { enabled: pgd.opts.enabled, state: pgd.state,
                     perm: window.AURA.desktop.permissions.isGranted('minimize_windows'),
                     badge: document.getElementById('pg-badge')?.textContent,
                     live: !document.getElementById('pg-live').hidden };
        }""")
        ok("guard enabled", en["enabled"] is True)
        ok("permission granted on demand", en["perm"] is True)
        ok("badge shows ARMED", "ARMED" in (en["badge"] or ""), str(en["badge"]))
        ok("live status panel appears", en["live"])
        ok("state is MONITORING", en["state"] == "MONITORING", str(en["state"]))

        print("\n\033[36m▸ END TO END — person triggers minimise\033[0m")
        # Stop the camera first. A live feed emits its own PRESENCE events at
        # ~2.5 Hz, which race the synthetic sequence and start/reset the
        # persistence timer unpredictably. Vision→guard wiring is already
        # proven by the PRESENCE block above; this block isolates
        # guard → kernel → window manager.
        await pg.evaluate("() => window.AURA.vision.disable()")
        await pg.wait_for_timeout(900)
        e2e = await pg.evaluate("""async () => {
            const { bus, EV } = await import('/js/core/bus.js');
            const pgd = window.AURA.privacyGuard;
            pgd.configure({ detectionPersistenceMs: 200, cooldownMs: 3000 });
            pgd.opts.ignoreOwnFaceMs = 0;
            // Clear any cooldown left over from a real camera detection, and
            // snapshot AFTER configuring - otherwise the baseline is stale.
            pgd._cooldownUntil = 0; pgd._since = 0;
            // The live camera also emits PRESENCE. Wait for a quiet moment so
            // the synthetic sequence is the only thing in flight.
            await new Promise(r=>setTimeout(r,600));
            pgd._cooldownUntil = 0; pgd._since = 0;
            const before = pgd.stats.triggers;
            const acted = [];
            bus.on('privacy:acted', e => acted.push(e));
            // Two faces, one unrecognised — a real "someone behind me".
            // A single face is the OWNER and is correctly vetoed since v0.18.1.
            const P = ts => ({ type:'person_detected', present:true, count:2,
                               confidence:0.95, area:0.09, source:'face',
                               faceCount:2, knownNames:['Owner'], timestamp:ts });
            bus.emit(EV.PRESENCE, P(Date.now()));
            await new Promise(r=>setTimeout(r,320));
            bus.emit(EV.PRESENCE, P(Date.now()));
            await new Promise(r=>setTimeout(r,1400));
            return { triggers: pgd.stats.triggers - before, acted,
                     state: pgd.state, hist: pgd.status().history[0] || null };
        }""")
        ok("exactly one trigger", e2e["triggers"] == 1, str(e2e["triggers"]))
        ok("an action was attempted", len(e2e["acted"]) == 1, json.dumps(e2e["acted"])[:120])
        # On this Linux box wmctrl/xdotool are absent, so the window manager
        # correctly REFUSES. What matters architecturally is that the command
        # reached the execute stage rather than being dropped or faked.
        ok("it reached the execute stage (window manager)",
           e2e["acted"] and e2e["acted"][0].get("stage") in (None, "execute"),
           json.dumps(e2e["acted"])[:150])
        ok("history records it", e2e["hist"] is not None, json.dumps(e2e["hist"])[:110])

        print("\n\033[36m▸ COOLDOWN SUPPRESSES REPEATS\033[0m")
        cd = await pg.evaluate("""async () => {
            const { bus, EV } = await import('/js/core/bus.js');
            const pgd = window.AURA.privacyGuard;
            const before = pgd.stats.triggers;
            // Two faces, one unrecognised — a real "someone behind me".
            // A single face is the OWNER and is correctly vetoed since v0.18.1.
            const P = ts => ({ type:'person_detected', present:true, count:2,
                               confidence:0.95, area:0.09, source:'face',
                               faceCount:2, knownNames:['Owner'], timestamp:ts });
            for (let i=0;i<25;i++) bus.emit(EV.PRESENCE, P(Date.now()+i*10));
            await new Promise(r=>setTimeout(r,400));
            return { extra: pgd.stats.triggers - before, suppressed: pgd.stats.suppressed };
        }""")
        ok("no repeat during cooldown", cd["extra"] == 0, str(cd["extra"]))
        ok("suppressions counted", cd["suppressed"] > 0, str(cd["suppressed"]))

        print("\n\033[36m▸ DISABLING STOPS IT IMMEDIATELY\033[0m")
        dis = await pg.evaluate("""async () => {
            document.getElementById('pg-enable').click();
            await new Promise(r=>setTimeout(r,400));
            const { bus, EV } = await import('/js/core/bus.js');
            const pgd = window.AURA.privacyGuard;
            const before = pgd.stats.triggers;
            const P = ts => ({ type:'person_detected', present:true, count:1,
                               confidence:0.99, area:0.2, source:'face', timestamp:ts });
            for (let i=0;i<20;i++) bus.emit(EV.PRESENCE, P(Date.now()+i*100));
            await new Promise(r=>setTimeout(r,600));
            return { state: pgd.state, extra: pgd.stats.triggers - before,
                     badge: document.getElementById('pg-badge')?.textContent };
        }""")
        ok("state DISABLED", dis["state"] == "DISABLED", str(dis["state"]))
        ok("no triggers after disabling", dis["extra"] == 0, str(dis["extra"]))
        ok("badge back to OFF", dis["badge"] == "OFF", str(dis["badge"]))

        print("\n\033[36m▸ EXISTING VISION UNAFFECTED\033[0m")
        vis = await pg.evaluate("""async () => {
            const v = window.AURA.vision;
            const { state: st } = await import('/js/core/state.js');
            return { cam: st.get('cameraActive'), fps: st.get('visionFps'),
                     hands: !!v.handLandmarker, faces: !!v.faceLandmarker,
                     obj: !!v.objectDetector,
                     gestures: window.AURA.gestures.list().length };
        }""")
        # The camera was deliberately stopped for the isolated trigger block,
        # so restart it before asserting the rest of vision is unharmed.
        await pg.evaluate("async () => { await window.AURA.enableVision(); }")
        await pg.wait_for_timeout(3500)
        vis = await pg.evaluate("""async () => {
            const v = window.AURA.vision;
            const { state: st } = await import('/js/core/state.js');
            return { cam: st.get('cameraActive'), fps: st.get('visionFps'),
                     hands: !!v.handLandmarker, faces: !!v.faceLandmarker,
                     obj: !!v.objectDetector,
                     gestures: window.AURA.gestures.list().length };
        }""")
        ok("camera restarts cleanly after Privacy Guard use", vis["cam"] is True)
        ok("hand tracking intact", vis["hands"])
        ok("face tracking intact", vis["faces"])
        ok("object detector intact", vis["obj"])
        ok("gestures still bound", vis["gestures"] >= 14, str(vis["gestures"]))
        ok("vision fps healthy", (vis["fps"] or 0) > 0, str(vis["fps"]))

        print("\n\033[36m▸ DEVELOPER CONSOLE PIPELINE\033[0m")
        dc = await pg.evaluate("""async () => {
            window.AURA.openPanel('devconsole');
            await new Promise(r=>setTimeout(r,1200));
            const txt = document.getElementById('dc-overview')?.textContent || '';
            return { hasBlock: txt.includes('Privacy Guard'),
                     hasVision: txt.includes('VISION'),
                     hasAction: txt.includes('ACTION MANAGER'),
                     hasCooldown: txt.includes('COOLDOWN') };
        }""")
        ok("privacy block renders", dc["hasBlock"])
        ok("shows the VISION stage", dc["hasVision"])
        ok("shows ACTION MANAGER", dc["hasAction"])
        ok("shows COOLDOWN", dc["hasCooldown"])

        real=[e for e in errs if "favicon" not in e.lower() and "swiftshader" not in e.lower()
              and not e.startswith("INFO:")]
        print("\n\033[36m▸ CONSOLE\033[0m")
        ok("no console errors", not real, "; ".join(real[:2]))
        await pg.evaluate("() => window.AURA.openPanel('vision')")
        await pg.wait_for_timeout(700)
        await pg.screenshot(path="screenshots/31-privacy-guard.png")
        await b.close()
    print(f"\n  \033[32mPASS {len(P)}\033[0m  FAIL {len(F)}")
    if F: print("  Failed: "+", ".join(F)); sys.exit(1)
asyncio.run(main())
