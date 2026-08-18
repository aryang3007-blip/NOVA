"""
AURA :: regression tests for the four bugs reported after Windows testing
=========================================================================
  1. /phone assumed "phone"; needs a device-type picker + auto-detect.
  2. No Settings -> Devices, so the pairing code was unreachable in the UI.
  3. A long settings tab crushed the tab strip to an unreadable sliver.
  4. Mic restart storm on first login (guard defeated itself).

    python3 serve.py 8221 --allow-actions &
    python3 tests/test-user-bugs-v2.py 8221
"""
import asyncio, sys
from playwright.async_api import async_playwright

PORT = sys.argv[1] if len(sys.argv) > 1 else "8221"
P, F = [], []


def ok(n, c, d=""):
    (P if c else F).append(n)
    print(("  \033[32m✓\033[0m " if c else "  \033[31m✗\033[0m ") + n
          + (f"  \033[90m{d}\033[0m" if d else ""))


async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch(args=[
            "--enable-unsafe-swiftshader", "--no-sandbox",
            "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"])

        # ══ BUG 1 · /phone device type picker ══════════════════════════
        print("\n\033[36m▸ BUG 1 · DEVICE TYPE IS CHOSEN, NOT ASSUMED\033[0m")
        pg = await b.new_page(viewport={"width": 500, "height": 900})
        errs = []
        pg.on("pageerror", lambda e: errs.append("PAGEERROR: " + str(e)))
        pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
        await pg.goto(f"http://127.0.0.1:{PORT}/phone", wait_until="load")
        await pg.wait_for_timeout(1200)

        t = await pg.evaluate("""() => {
            const tiles = [...document.querySelectorAll('.dtype')]
                .map(e => e.dataset.dtype);
            return { tiles, detect: !!document.getElementById('btn-detect'),
                     selected: document.querySelector('.dtype.on')?.dataset.dtype,
                     guessed: !!document.querySelector('.dtype.on.guess'),
                     why: document.getElementById('dtype-why')?.textContent || '' };
        }""")
        for want in ["android", "ios", "windows", "macos", "linux"]:
            ok(f"{want} is offered", want in t["tiles"])
        ok("AUTO-DETECT button exists", t["detect"])
        ok("something is pre-selected", bool(t["selected"]), str(t["selected"]))
        ok("...and is marked as a GUESS, not a fact", t["guessed"])
        ok("it explains its reasoning", len(t["why"]) > 20, t["why"][:60])

        # This is a desktop Chromium, so it must detect Linux/Windows, not phone.
        ok("a desktop browser is NOT called a phone",
           t["selected"] in ("linux", "windows", "macos"), str(t["selected"]))

        # Picking Windows must remove vibrate; picking Android must offer it.
        caps = await pg.evaluate("""async () => {
            const pick = (k) => document.querySelector(`.dtype[data-dtype="${k}"]`).click();
            const capsOn = () => [...document.querySelectorAll('.cap.on')].map(e => e.textContent);
            pick('windows'); await new Promise(r => setTimeout(r, 120));
            const win = { caps: capsOn(), name: document.getElementById('name').value,
                          sub: document.getElementById('sub').textContent };
            pick('android'); await new Promise(r => setTimeout(r, 120));
            const and = { caps: capsOn(), name: document.getElementById('name').value,
                          sub: document.getElementById('sub').textContent };
            pick('ios'); await new Promise(r => setTimeout(r, 120));
            const ios = { caps: capsOn() };
            return { win, and, ios };
        }""")
        ok("Windows never offers vibrate", "vibrate" not in caps["win"]["caps"],
           str(caps["win"]["caps"]))
        ok("iOS never offers vibrate (Safari has no API)",
           "vibrate" not in caps["ios"]["caps"], str(caps["ios"]["caps"]))
        ok("Windows default name is not 'Phone'",
           "phone" not in caps["win"]["name"].lower(), caps["win"]["name"])
        ok("Android default name says Android",
           "android" in caps["and"]["name"].lower(), caps["and"]["name"])
        ok("the header copy changes per device class",
           caps["win"]["sub"] != caps["and"]["sub"], caps["win"]["sub"][:44])
        ok("open_url is offered everywhere", "open_url" in caps["win"]["caps"]
           and "open_url" in caps["and"]["caps"])
        ok("no console errors on /phone",
           not [e for e in errs if "favicon" not in e.lower()], "; ".join(errs[:2]))
        await pg.close()

        # ══ BUGS 2 & 3 · main app ══════════════════════════════════════
        pg = await b.new_page(viewport={"width": 900, "height": 520})
        errs2 = []
        pg.on("pageerror", lambda e: errs2.append("PAGEERROR: " + str(e)))
        pg.on("console", lambda m: errs2.append(m.text) if m.type == "error" else None)
        await pg.goto(f"http://127.0.0.1:{PORT}/", wait_until="load")
        await pg.wait_for_selector("#boot-enter:not([hidden])", timeout=45000)
        await pg.click("#boot-enter")
        await pg.wait_for_timeout(2000)
        await pg.evaluate("() => document.querySelectorAll('.setup').forEach(e => e.remove())")

        print("\n\033[36m▸ BUG 2 · SETTINGS -> DEVICES EXISTS AND WORKS\033[0m")
        await pg.evaluate("() => window.AURA.openSettings()")
        await pg.wait_for_timeout(400)
        d = await pg.evaluate("""() => {
            const tabs = [...document.querySelectorAll('#settings .tab')].map(t => t.dataset.tab);
            return { tabs, hasTab: tabs.includes('devices'),
                     pane: !!document.querySelector('.tabpane[data-tab="devices"]'),
                     btn: !!document.getElementById('dev-pair'),
                     list: !!document.getElementById('dev-list') };
        }""")
        ok("a DEVICES tab exists", d["hasTab"], str(d["tabs"]))
        ok("its pane exists", d["pane"])
        ok("PAIR A DEVICE button exists", d["btn"])
        ok("paired-device list exists", d["list"])

        await pg.click('#settings .tab[data-tab="devices"]')
        await pg.wait_for_timeout(600)
        await pg.click("#dev-pair")
        await pg.wait_for_timeout(1200)
        code = await pg.evaluate("""() => ({
            shown: !document.getElementById('dev-code-box').hidden,
            code: document.getElementById('dev-code').textContent.trim(),
            sub: document.getElementById('dev-code-sub').textContent,
            badge: document.getElementById('dev-pair-badge').textContent,
            lan: document.getElementById('dev-lan').textContent,
        })""")
        ok("pressing it shows a code", code["shown"])
        ok("the code is 6 digits", code["code"].isdigit() and len(code["code"]) == 6,
           code["code"])
        ok("it counts down", "expires in" in code["sub"], code["sub"])
        ok("badge says WAITING", code["badge"] == "WAITING", code["badge"])
        ok("it tells you the companion URL", "/phone" in code["lan"], code["lan"][:56])

        # The code the UI shows must be the one the gateway will accept.
        real = await pg.evaluate("""async () => {
            const r = await window.AURA.actions.deviceList();
            return { pairing: r.pairing || null };
        }""")
        ok("the displayed code is the gateway's real code",
           bool(real["pairing"]) and real["pairing"].get("code") == code["code"],
           str(real["pairing"]))

        print("\n\033[36m▸ BUG 3 · THE TAB STRIP SURVIVES A LONG TAB\033[0m")
        for tab in ["ai", "connect", "devices", "desktop", "appearance", "about"]:
            await pg.click(f'#settings .tab[data-tab="{tab}"]')
            await pg.wait_for_timeout(200)
            m = await pg.evaluate("""() => {
                const tabs = document.querySelector('#settings .tabs');
                const box  = document.querySelector('#settings .modal-box');
                const body = document.querySelector('#settings .modal-body');
                body.scrollTop = body.scrollHeight;   // read to the bottom
                const first = tabs.querySelector('.tab').getBoundingClientRect();
                const tr = tabs.getBoundingClientRect(), br = box.getBoundingClientRect();
                const vis = Math.max(0, Math.min(tr.bottom, br.bottom) - Math.max(tr.top, br.top));
                return { need: Math.round(first.height), got: Math.round(vis),
                         strip: Math.round(tr.height),
                         shrink: getComputedStyle(tabs).flexShrink,
                         bodyTop: body.scrollTop };
            }""")
            ok(f"{tab}: tab labels stay fully visible",
               m["got"] >= m["need"] - 1 and m["strip"] >= 24,
               f"strip={m['strip']}px visible={m['got']}/{m['need']}px shrink={m['shrink']}")

        sw = await pg.evaluate("""() => {
            document.querySelector('#settings .tab[data-tab="about"]').click();
            const body = document.querySelector('#settings .modal-body');
            body.scrollTop = body.scrollHeight;
            const before = body.scrollTop;
            document.querySelector('#settings .tab[data-tab="ai"]').click();
            return { before, after: body.scrollTop };
        }""")
        ok("switching tabs scrolls back to the top",
           sw["before"] > 0 and sw["after"] == 0, str(sw))

        print("\n\033[36m▸ BUG 4 · MIC RESTART STORM IS BOUNDED\033[0m")
        # decideRestart() is the pure guard extracted from the onend closure.
        # Drive it directly in the live page: no timers, no real recogniser.
        storm = await pg.evaluate("""async () => {
            const { SpeechInput } = await import('/js/voice/speech.js');
            const dead = new SpeechInput();
            let gaveUpAfter = null;
            for (let i = 0; i < 60; i++) {
                dead._startedAt = Date.now() - 5;      // died in 5ms
                dead._sawResultThisSession = false;
                if (dead.decideRestart(Date.now()).giveUp) { gaveUpAfter = i; break; }
            }
            const healthy = new SpeechInput();
            let healthyGaveUp = false;
            for (let i = 0; i < 300; i++) {
                healthy._startedAt = Date.now() - 2000;
                healthy._sawResultThisSession = false;
                if (healthy.decideRestart(Date.now()).giveUp) { healthyGaveUp = true; break; }
            }
            const streaks = [];
            const s3 = new SpeechInput();
            for (let i = 0; i < 5; i++) {
                s3._startedAt = Date.now() - 5; s3._sawResultThisSession = false;
                streaks.push(s3.decideRestart(Date.now()).streak);
            }
            return { gaveUpAfter, healthyGaveUp, streaks,
                     minHealthy: SpeechInput.MIN_HEALTHY_MS,
                     maxFails: SpeechInput.MAX_FAILED_RESTARTS };
        }""")
        ok("a dead mic stops retrying", storm["gaveUpAfter"] is not None,
           f"gave up after {storm['gaveUpAfter']}")
        ok("...within a handful of tries",
           storm["gaveUpAfter"] is not None and storm["gaveUpAfter"] <= 6,
           str(storm["gaveUpAfter"]))
        ok("the failure streak never resets on its own",
           storm["streaks"] == [1, 2, 3, 4, 5], str(storm["streaks"]))
        ok("a HEALTHY mic is never shut off", storm["healthyGaveUp"] is False)

        print("\n\033[36m▸ CONSOLE\033[0m")
        real2 = [e for e in errs2 if "favicon" not in e.lower()
                 and "swiftshader" not in e.lower() and not e.startswith("INFO:")]
        ok("no console errors in the main app", not real2, "; ".join(real2[:2]))

        await pg.click('#settings .tab[data-tab="devices"]')
        await pg.wait_for_timeout(400)
        await pg.screenshot(path="screenshots/35-settings-devices.png")
        await pg.close()
        await b.close()

    print(f"\n  \033[32mPASS {len(P)}\033[0m  FAIL {len(F)}")
    if F:
        print("  Failed: " + ", ".join(F))
        sys.exit(1)


asyncio.run(main())
