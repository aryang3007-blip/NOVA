"""
AURA :: phone companion page + camera honesty + AURA Live fix
=============================================================
Spec tests C, D, F, H, I, O, P plus the camera-context reporting.

    PYTHONPATH=/tmp python3 serve.py 8184 --allow-actions --allow-lan &
    python3 tests/test-phone-page.py 8184
"""
import asyncio, sys, json, urllib.request
from playwright.async_api import async_playwright
PORT = sys.argv[1] if len(sys.argv)>1 else "8184"
BASE = f"http://127.0.0.1:{PORT}"
P=[];F=[]
def ok(n,c,d=""):
    (P if c else F).append(n)
    print(("  \033[32m✓\033[0m " if c else "  \033[31m✗\033[0m ")+n+(f"  \033[90m{d}\033[0m" if d else ""))

def host_token():
    return json.load(urllib.request.urlopen(f"{BASE}/api/token"))["token"]

def post(path, body, token=None):
    req = urllib.request.Request(f"{BASE}{path}", method="POST",
        data=json.dumps(body).encode(), headers={"Content-Type":"application/json",
        **({"X-AURA-Token": token} if token else {})})
    try:
        return json.load(urllib.request.urlopen(req, timeout=25))
    except Exception as e:
        return {"ok": False, "err": str(e)}

async def main():
    async with async_playwright() as pw:
        b=await pw.chromium.launch(args=["--enable-unsafe-swiftshader","--no-sandbox",
            "--use-fake-ui-for-media-stream","--use-fake-device-for-media-stream"])
        pg=await (await b.new_context(viewport={"width":420,"height":880})).new_page()
        errs=[]
        pg.on("pageerror", lambda e: errs.append("PAGEERROR: "+str(e)[:200]))
        pg.on("console", lambda m: errs.append(m.text)
              if m.type=="error" and not m.text.startswith("INFO:") else None)

        print("\n\033[36m▸ C — PHONE PAGE LOADS\033[0m")
        await pg.goto(f"{BASE}/phone", wait_until="load")
        await pg.wait_for_timeout(2500)
        dom = await pg.evaluate("""() => ({
            title: document.title,
            pairCard: !!document.getElementById('pair-card'),
            code: !!document.getElementById('code'),
            camCard: !document.getElementById('cam-card').classList.contains('hide'),
            caps: [...document.querySelectorAll('.cap.on')].map(c=>c.textContent),
        })""")
        ok("companion page serves", "AURA Companion" in dom["title"], dom["title"])
        ok("pairing UI present", dom["pairCard"] and dom["code"])
        ok("camera card is shown", dom["camCard"])
        ok("it declares real capabilities", len(dom["caps"]) >= 2, str(dom["caps"]))

        print("\n\033[36m▸ H — CAMERA CONTEXT REPORTED HONESTLY\033[0m")
        cam = await pg.evaluate("""() => ({
            secure: window.isSecureContext,
            uiSecure: document.getElementById('cam-sec').textContent,
            uiApi: document.getElementById('cam-api').textContent,
            why: document.getElementById('cam-why').textContent,
            noteShown: !document.getElementById('cam-note').classList.contains('hide'),
            note: document.getElementById('cam-note').textContent,
        })""")
        ok("secure-context state is reported", cam["uiSecure"] in ("yes","NO"), cam["uiSecure"])
        ok("getUserMedia availability is reported",
           cam["uiApi"] in ("available","missing"), cam["uiApi"])
        ok("the reported state matches reality",
           (cam["uiSecure"]=="yes") == bool(cam["secure"]),
           f"secure={cam['secure']} ui={cam['uiSecure']}")
        # 127.0.0.1 IS a secure context, so this branch should say it works.
        if cam["secure"]:
            ok("on a secure origin it says the camera can be used",
               # v0.20.1: copy is platform-neutral now — this page also runs
               # on a Windows/Linux/Mac companion, not only a phone.
               "can use this device" in cam["why"], cam["why"][:80])
        else:
            ok("on plain HTTP it blames the insecure context",
               "insecure context" in cam["why"], cam["why"][:80])
            ok("and gives real remedies, not a workaround claim",
               "HTTPS" in cam["note"] and "will not pretend" in cam["note"])

        print("\n\033[36m▸ D — PAIRING FROM THE PHONE PAGE\033[0m")
        tok = host_token()
        code = post("/api/devices/pair-start", {}, tok)["code"]
        paired = await pg.evaluate(f"""async () => {{
            document.getElementById('name').value = 'Test Phone';
            document.getElementById('code').value = '{code}';
            document.getElementById('btn-pair').click();
            await new Promise(r => setTimeout(r, 2500));
            return {{
              connected: !document.getElementById('conn-card').classList.contains('hide'),
              hidden: document.getElementById('pair-card').classList.contains('hide'),
              id: document.getElementById('d-id').textContent,
              stored: !!localStorage.getItem('aura.device.v1'),
            }};
        }}""")
        ok("the phone pairs from the UI", paired["connected"], str(paired))
        ok("the pairing form is hidden after success", paired["hidden"])
        # v0.20.1: the id prefix is the DETECTED platform, not a hardcoded
        # "android". This suite runs in desktop Chromium, so linux-NNN is the
        # correct answer — the old assertion baked in the bug the user found.
        ok("a device id is shown, prefixed with the real platform",
           any(paired["id"].startswith(p + "-")
               for p in ("android", "ios", "windows", "macos", "linux")),
           paired["id"])
        ok("the pairing persists locally for reconnects", paired["stored"])

        await pg.wait_for_timeout(2000)
        live = await pg.evaluate("""() => ({
            state: document.getElementById('conn-state').textContent,
            dot: document.getElementById('dot').classList.contains('on'),
            lat: document.getElementById('d-lat').textContent })""")
        ok("heartbeat marks it connected", live["dot"], str(live))
        ok("latency is measured", "ms" in live["lat"], live["lat"])

        print("\n\033[36m▸ F — 'OPEN YOUTUBE ON MY PHONE' REACHES THE PHONE\033[0m")
        # Target the device THIS test paired. Using the generic "phone" can
        # resolve to an older pairing left over from another run.
        sent = post("/api/devices/send",
                    {"device": paired["id"], "action":"open_url",
                     "params":{"url":"https://youtube.com"}}, tok)
        ok("the laptop queues the action", sent.get("ok"), str(sent)[:110])
        await pg.wait_for_timeout(3000)
        got = await pg.evaluate("""() => ({
            log: document.getElementById('log').textContent,
            acts: document.getElementById('d-acts').textContent })""")
        ok("the phone received and ran it", "youtube.com" in got["log"], got["log"][:110])
        ok("the action counter advanced", got["acts"] != "0", got["acts"])

        print("\n\033[36m▸ M — OFFLINE PHONE IS NOT FAKED\033[0m")
        await pg.evaluate("() => { window.stop?.(); }")
        offline = post("/api/devices/send",
                       {"device":"nonexistent-phone","action":"open_url",
                        "params":{"url":"https://x.com"}}, tok)
        ok("an unknown device is refused", not offline.get("ok"), str(offline)[:100])

        print("\n\033[36m▸ N — UNPAIRED DEVICE BLOCKED OVER HTTP\033[0m")
        forged = post("/api/device/poll",
                      {"deviceId": paired["id"], "token": "forged-token", "wait": 1})
        # urllib raises on 401, so `err` is the honest signal here.
        ok("forged device token rejected",
           forged.get("code") == 401 or "401" in str(forged.get("err", "")),
           str(forged)[:90])
        ok("host route needs the host token",
           post("/api/devices/send", {"device":"phone","action":"open_url"}).get("ok") is False)

        print("\n\033[36m▸ AURA LIVE — THE REPORTED FAILURE\033[0m")
        pg2 = await (await b.new_context(viewport={"width":1400,"height":900})).new_page()
        errs2=[]
        pg2.on("pageerror", lambda e: errs2.append(str(e)[:200]))
        await pg2.goto(f"{BASE}/screen", wait_until="load")
        await pg2.wait_for_timeout(6000)
        lv = await pg2.evaluate("""() => ({
            provider: window.__aura_live_provider || null,
            pill: document.getElementById('pill-model')?.textContent,
            cards: document.querySelectorAll('.card').length,
        })""")
        ok("AURA Live renders", lv["cards"] >= 8, str(lv["cards"]))
        ok("it no longer silently skips provider resolution",
           lv["pill"] not in (None, ""), str(lv["pill"]))
        ok("no page errors", not errs2, "; ".join(errs2[:2]))


        print("\n\033[36m▸ FACE ENROLMENT VISUALS\033[0m")
        pg3 = await (await b.new_context(permissions=["camera"],
                     viewport={"width":1400,"height":900})).new_page()
        await pg3.goto(f"{BASE}/", wait_until="load")
        await pg3.wait_for_timeout(6000)
        for sel in ["#boot-go", "text=INITIALIZE"]:
            try: await pg3.click(sel, timeout=3000); break
            except Exception: pass
        await pg3.wait_for_timeout(5000)
        en = await pg3.evaluate("""async () => {
            await window.AURA.enableVision();
            await new Promise(r=>setTimeout(r,3000));
            const v = window.AURA.vision;
            const { config } = await import('/js/core/config.js');
            config.set('faceRecognition', true);
            const started = await v.startEnrollment('TestUser');
            const armed = !!v._enrollViz;
            v._enrollViz = { pct: 0.66, label: 'SCANNING 2/3' };
            const fake = Array.from({length:100},(_,i)=>({
                x: 0.36 + (i%10)*0.028, y: 0.28 + Math.floor(i/10)*0.032, z:0 }));
            v._draw([], [fake], []);
            const cv = document.getElementById('overlay');
            const d = cv.getContext('2d').getImageData(0,0,cv.width,cv.height).data;
            let painted=0, green=0;
            for (let i=0;i<d.length;i+=400) {
              if (d[i+3] > 20) painted++;
              if (d[i+1] > 150 && d[i] < 120) green++;
            }
            await v.cancelEnrollment();
            return { started: started.ok, armed, painted, green, cleared: !v._enrollViz };
        }""")
        ok("enrolment starts", en["started"], str(en["started"]))
        ok("the scan overlay arms on the FIRST frame", en["armed"],
           "was null until an identify happened — the reported 'nothing visible'")
        ok("something is actually drawn on the face", en["painted"] > 40,
           f"{en['painted']} painted samples")
        ok("in the scan colour, not just the idle mesh", en["green"] > 20,
           f"{en['green']} green samples")
        ok("the overlay clears when enrolment ends", en["cleared"])

        real=[e for e in errs if "favicon" not in e.lower() and "swiftshader" not in e.lower()
              and not e.startswith("INFO:")]
        print("\n\033[36m▸ CONSOLE\033[0m")
        ok("phone page has no console errors", not real, "; ".join(real[:2]))
        await pg.screenshot(path="screenshots/32-phone-companion.png")
        await b.close()
    print(f"\n  \033[32mPASS {len(P)}\033[0m  FAIL {len(F)}")
    if F: print("  Failed: "+", ".join(F)); sys.exit(1)
asyncio.run(main())
