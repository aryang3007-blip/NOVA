"""
AURA :: dwell-to-click in a real browser
========================================
The unit tests prove the state machine. This proves the FEATURE: that holding a
fingertip over a real button in a real page really clicks it, that the ring is
really painted onto the canvas, and that the desktop path really refuses
without permission.

    python3 serve.py 8199 --allow-actions &
    python3 tests/test-dwell-ui.py 8199
"""
import asyncio, sys
from playwright.async_api import async_playwright

PORT = sys.argv[1] if len(sys.argv) > 1 else "8199"
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
        ctx = await b.new_context(permissions=["camera"],
                                  viewport={"width": 1500, "height": 950})
        pg = await ctx.new_page()
        errs = []
        pg.on("pageerror", lambda e: errs.append("PAGEERROR: " + str(e)))
        pg.on("console", lambda m: errs.append(m.text)
              if m.type == "error" and not m.text.startswith("INFO:") else None)
        pg.on("dialog", lambda d: asyncio.ensure_future(d.accept()))

        # The first-run "CONNECT A BRAIN" wizard is created dynamically with no
        # id, and its backdrop swallows every click. Mark setup as done BEFORE
        # the app boots so it is never shown in the first place.
        await ctx.add_init_script("""() => {
            try {
                const k = 'aura.config.v1';
                const c = JSON.parse(localStorage.getItem(k) || '{}');
                c.setupDone = true;
                localStorage.setItem(k, JSON.stringify(c));
            } catch (e) {}
        }""")
        await pg.goto(f"http://127.0.0.1:{PORT}/", wait_until="load")
        try:
            await pg.wait_for_selector("#boot-enter:not([hidden])", timeout=40000)
            await pg.click("#boot-enter")
        except Exception:
            pass
        await pg.wait_for_timeout(3000)

        # ── A. mounted and off ────────────────────────────────────────
        print("\n\033[36m▸ A · MOUNTED, OFF BY DEFAULT\033[0m")
        a = await pg.evaluate("""() => {
            const im = window.AURA.interaction;
            return { exists: !!im, enabled: im?.enabled, state: im?.dwell?.state,
                     ui: !!document.getElementById('dw-enable'),
                     badge: document.getElementById('dw-badge')?.textContent,
                     liveHidden: document.getElementById('dw-live')?.hidden,
                     perm: window.AURA.desktop.permissions.isGranted('vision_mouse'),
                     permExists: !!window.AURA.desktop.permissions.list()
                                    .find(p => p.id === 'vision_mouse') };
        }""")
        ok("InteractionManager is mounted", a["exists"])
        ok("dwell is OFF by default", a["enabled"] is False, str(a["enabled"]))
        ok("state is IDLE", a["state"] == "IDLE", str(a["state"]))
        ok("UI exists in the Vision panel", a["ui"])
        ok("badge reads OFF", a["badge"] == "OFF", str(a["badge"]))
        ok("live readout hidden while off", a["liveHidden"] is True)
        ok("Vision Mouse Control permission is registered", a["permExists"])
        ok("...and is NOT granted by default", a["perm"] is False)

        # ── B. a real dwell clicks a real button ──────────────────────
        print("\n\033[36m▸ B · A HELD FINGERTIP CLICKS A REAL BUTTON\033[0m")
        await pg.evaluate("""async () => {
            const m = await import('/js/vision/dwell.js');
            window.__ringOf = (p) => m.DwellController.ringOf(p);
        }""")
        b1 = await pg.evaluate("""async () => {
            const im = window.AURA.interaction;
            im.setEnabled(true);

            // A real button in the real page, with a real handler.
            const btn = document.createElement('button');
            btn.id = 'dwell-probe';
            btn.textContent = 'PROBE';
            btn.setAttribute('aria-label', 'Dwell probe button');
            Object.assign(btn.style, { position: 'fixed', left: '600px', top: '400px',
                width: '200px', height: '80px', zIndex: 99999 });
            let clicks = 0, lastX = null;
            btn.addEventListener('click', (e) => { clicks++; lastX = e.clientX; });
            document.body.appendChild(btn);

            const r = btn.getBoundingClientRect();
            const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
            // Feed NORMALISED, MIRRORED coordinates, exactly as vision.js does.
            const nx = 1 - (cx / window.innerWidth), ny = cy / window.innerHeight;

            const seenRings = [];
            let fired = null;
            for (let t = 0; t <= 1400; t += 33) {
                const res = im.feed({ x: nx, y: ny, confidence: 0.9 }, t);
                // Read the ring the UI is actually told about, via the bus
                // payload's source of truth — the RESULT, not live state.
                const ring = window.__ringOf(res ? res.progress : 0);
                if (!seenRings.includes(ring)) seenRings.push(ring);
                if (res && res.fired) fired = t;
            }
            await new Promise(r2 => setTimeout(r2, 250));   // let commit() settle
            return { clicks, lastX, fired, seenRings,
                     targetKind: im.target.kind,
                     hist: im.history[0] || null,
                     expectedX: Math.round(cx) };
        }""")
        ok("dwell reached 100%", b1["fired"] is not None, f"fired at {b1['fired']}ms")
        ok("classified as a web target", b1["targetKind"] == "web", str(b1["targetKind"]))
        ok("THE BUTTON WAS ACTUALLY CLICKED", b1["clicks"] == 1, f"{b1['clicks']} clicks")
        ok("click carried real coordinates",
           b1["lastX"] is not None and abs(b1["lastX"] - b1["expectedX"]) <= 2,
           f"{b1['lastX']} vs {b1['expectedX']}")
        ok("ring passed 0/25/50/75/100",
           all(v in b1["seenRings"] for v in [0, 25, 50, 75, 100]), str(b1["seenRings"]))
        ok("history records the click",
           bool(b1["hist"] and b1["hist"].get("ok") and b1["hist"].get("kind") == "web"),
           str(b1["hist"]))
        ok("history names the control",
           bool(b1["hist"] and "Dwell probe button" in str(b1["hist"].get("message", ""))),
           str(b1["hist"] or {}).get if False else str((b1["hist"] or {}).get("message")))

        # ── C. a passing hand does NOT click ──────────────────────────
        print("\n\033[36m▸ C · A HAND SWEEPING PAST DOES NOT CLICK\033[0m")
        c = await pg.evaluate("""async () => {
            const im = window.AURA.interaction;
            const btn = document.getElementById('dwell-probe');
            let clicks = 0;
            btn.addEventListener('click', () => clicks++);
            im.dwell.reset('test'); im.dwell.lastFire = null;
            const r = btn.getBoundingClientRect();
            const ny = (r.top + r.height/2) / window.innerHeight;
            let maxProgress = 0;
            for (let i = 0; i <= 40; i++) {
                const res = im.feed({ x: 0.05 + i * 0.022, y: ny, confidence: .9 }, 5000 + i * 33);
                maxProgress = Math.max(maxProgress, res ? res.progress : 0);
            }
            await new Promise(r2 => setTimeout(r2, 150));
            return { clicks, maxProgress };
        }""")
        ok("a sweeping hand never accumulates progress", c["maxProgress"] == 0,
           str(c["maxProgress"]))
        ok("a sweeping hand never clicks", c["clicks"] == 0, f"{c['clicks']} clicks")

        # ── D. disabled means disabled ────────────────────────────────
        print("\n\033[36m▸ D · DISABLING REALLY STOPS IT\033[0m")
        d = await pg.evaluate("""async () => {
            const im = window.AURA.interaction;
            const btn = document.getElementById('dwell-probe');
            let clicks = 0;
            btn.addEventListener('click', () => clicks++);
            im.setEnabled(false);
            const r = btn.getBoundingClientRect();
            const nx = 1 - (r.left + r.width/2) / window.innerWidth;
            const ny = (r.top + r.height/2) / window.innerHeight;
            for (let t = 0; t <= 4000; t += 33) im.feed({ x: nx, y: ny, confidence: .9 }, 20000 + t);
            await new Promise(r2 => setTimeout(r2, 150));
            return { clicks, state: im.dwell.state, enabled: im.enabled };
        }""")
        ok("no clicks while disabled", d["clicks"] == 0, f"{d['clicks']} clicks")
        ok("stays IDLE while disabled", d["state"] == "IDLE", str(d["state"]))

        # ── E. the desktop path refuses honestly ──────────────────────
        print("\n\033[36m▸ E · THE DESKTOP PATH REFUSES WITHOUT PERMISSION\033[0m")
        e = await pg.evaluate("""async () => {
            const im = window.AURA.interaction;
            im.setEnabled(true);
            // Pretend a whole monitor is shared, but grant nothing.
            const fake = { geometry: () => ({ capturedWidth: 1920, capturedHeight: 1080,
                                              scale: 1 }),
                           surface: 'monitor',
                           toScreenPoint: (x, y) => ({ ok: true, x: Math.round(x),
                                                       y: Math.round(y) }) };
            const realScreen = im.screen;
            im.screen = fake;
            const t1 = im.classify({ x: 0.02, y: 0.97 });   // corner: no AURA control
            const r1 = await im.commit({ x: 0.02, y: 0.97 });

            window.AURA.desktop.permissions.grant('vision_mouse');
            const t2 = im.classify({ x: 0.02, y: 0.97 });
            const r2 = await im.commit({ x: 0.02, y: 0.97 });
            window.AURA.desktop.permissions.revoke('vision_mouse');

            // A window share must be refused even WITH the permission.
            window.AURA.desktop.permissions.grant('vision_mouse');
            im.screen = { ...fake, surface: 'window',
                          toScreenPoint: () => ({ ok: false,
                              message: 'You are sharing a window, not a monitor.' }) };
            const t3 = im.classify({ x: 0.02, y: 0.97 });
            window.AURA.desktop.permissions.revoke('vision_mouse');
            im.screen = realScreen;
            im.setEnabled(false);
            return { t1, r1, t2, r2, t3 };
        }""")
        ok("no permission -> desktop target flagged",
           e["t1"]["kind"] == "desktop" and e["t1"].get("needsPermission") is True,
           f"{e['t1']['kind']}/{e['t1'].get('needsPermission')}")
        ok("no permission -> click REFUSED", e["r1"]["ok"] is False, str(e["r1"]["ok"]))
        ok("refusal names the permission",
           "Vision Mouse Control" in e["r1"]["message"], e["r1"]["message"][:70])
        ok("granted -> target no longer blocked",
           e["t2"]["kind"] == "desktop" and not e["t2"].get("needsPermission"),
           f"{e['t2']['kind']}/{e['t2'].get('needsPermission')}")
        ok("granted -> reaches the bridge and reports its real answer",
           e["r2"]["kind"] == "desktop" and isinstance(e["r2"]["message"], str)
           and len(e["r2"]["message"]) > 0, str(e["r2"])[:110])
        ok("granted but window-share -> still refused",
           e["t3"]["kind"] == "none" and "Entire Screen" in e["t3"]["reason"],
           f"{e['t3']['kind']}: {e['t3']['reason'][:60]}")

        # ── F. the ring is really painted ─────────────────────────────
        print("\n\033[36m▸ F · THE PROGRESS RING IS REALLY PAINTED\033[0m")
        f = await pg.evaluate("""() => {
            const v = window.AURA.vision;
            const c = document.getElementById('overlay');
            c.width = 640; c.height = 480;
            const ctx = c.getContext('2d');
            ctx.clearRect(0, 0, 640, 480);
            const before = ctx.getImageData(0, 0, 640, 480).data;
            let inkBefore = 0;
            for (let i = 3; i < before.length; i += 4) if (before[i] > 12) inkBefore++;

            v.setDwell({ state: 'DWELLING', progress: 0.75, ring: 75,
                         point: { x: 0.5, y: 0.5 }, target: 'web', label: 'CLICK' });
            v._drawDwell(ctx, 640, 480);
            const after = ctx.getImageData(0, 0, 640, 480).data;
            let inkAfter = 0;
            for (let i = 3; i < after.length; i += 4) if (after[i] > 12) inkAfter++;

            // Nothing at all when dwell is off.
            ctx.clearRect(0, 0, 640, 480);
            v.setDwell(null);
            v._drawDwell(ctx, 640, 480);
            const off = ctx.getImageData(0, 0, 640, 480).data;
            let inkOff = 0;
            for (let i = 3; i < off.length; i += 4) if (off[i] > 12) inkOff++;
            return { inkBefore, inkAfter, inkOff };
        }""")
        ok("canvas starts empty", f["inkBefore"] == 0, str(f["inkBefore"]))
        ok("the ring paints real pixels", f["inkAfter"] > 800,
           f"{f['inkAfter']} px drawn")
        ok("nothing is drawn when dwell is off", f["inkOff"] == 0, str(f["inkOff"]))

        # ── G. the toggle wires through to config ─────────────────────
        print("\n\033[36m▸ G · THE UI TOGGLE IS REAL\033[0m")
        # The first-run "CONNECT A BRAIN" wizard is built dynamically with class
        # .setup and no id, and its backdrop swallows every click. Close it the
        # same way its own X button does, then confirm it is really gone.
        await pg.evaluate("""() => {
            window.AURA.setupWizard?.close?.();
            document.querySelectorAll('.setup').forEach(e => e.remove());
        }""")
        await pg.wait_for_timeout(300)
        gone = await pg.evaluate("() => document.querySelectorAll('.setup').length")
        ok("the setup wizard is out of the way", gone == 0, f"{gone} left")
        await pg.evaluate("() => window.AURA.openPanel('vision')")
        await pg.wait_for_timeout(400)
        # The checkbox itself is display:none (styled .switch); click the label,
        # exactly as a user does.
        await pg.click("label:has(#dw-enable)")
        await pg.wait_for_timeout(350)
        g = await pg.evaluate("""() => ({
            enabled: window.AURA.interaction.enabled,
            badge: document.getElementById('dw-badge').textContent,
            liveHidden: document.getElementById('dw-live').hidden,
            cfg: window.AURA.config?.get?.('dwellClick'),
            warn: document.getElementById('dw-perm').hidden,
            warnText: document.getElementById('dw-perm').textContent.slice(0, 60),
        })""")
        ok("clicking the switch enables dwell", g["enabled"] is True)
        ok("badge flips to ARMED", g["badge"] == "ARMED", str(g["badge"]))
        ok("live readout appears", g["liveHidden"] is False)
        ok("the permission warning is shown and honest",
           g["warn"] is False and "no permission" in g["warnText"].lower()
           or "Desktop clicks are off" in g["warnText"], g["warnText"])

        await pg.evaluate("""() => {
            const s = document.getElementById('dw-ms');
            s.value = '1600'; s.dispatchEvent(new Event('input', { bubbles: true }));
        }""")
        await pg.wait_for_timeout(200)
        g2 = await pg.evaluate("""() => ({
            ms: window.AURA.interaction.dwell.opts.dwellMs,
            label: document.getElementById('dw-ms-v').textContent,
        })""")
        ok("the hold-time slider really retunes the machine", g2["ms"] == 1600, str(g2["ms"]))
        ok("its label updates", g2["label"] == "1600 ms", str(g2["label"]))

        await pg.click("label:has(#dw-enable)")
        await pg.wait_for_timeout(250)
        off = await pg.evaluate("() => window.AURA.interaction.enabled")
        ok("clicking again disables it", off is False)

        # ── H. no console errors ──────────────────────────────────────
        print("\n\033[36m▸ H · CONSOLE\033[0m")
        real = [e for e in errs if "favicon" not in e.lower()
                and "swiftshader" not in e.lower() and not e.startswith("INFO:")]
        ok("no console errors", not real, "; ".join(real[:2]))

        await pg.evaluate("() => document.getElementById('dwell-probe')?.remove()")
        await pg.evaluate("() => window.AURA.openPanel('vision')")
        await pg.wait_for_timeout(500)
        await pg.screenshot(path="screenshots/33-dwell-click.png")
        await b.close()

    print(f"\n  \033[32mPASS {len(P)}\033[0m  FAIL {len(F)}")
    if F:
        print("  Failed: " + ", ".join(F))
        sys.exit(1)


asyncio.run(main())
