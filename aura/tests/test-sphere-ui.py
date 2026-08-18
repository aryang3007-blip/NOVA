"""
AURA :: AI Sphere + task card, in a real browser
================================================
Unit tests cover the state table. This proves the sphere PAINTS, that each
state paints differently, that the canvas tracks its container, and that the
sphere follows REAL agent events rather than a timer.

Also covers the task card: plan, progress from real steps, cancel, artifacts.

    python3 serve.py 8252 --allow-actions &
    python3 tests/test-sphere-ui.py 8252
"""
import asyncio, sys
from playwright.async_api import async_playwright

PORT = sys.argv[1] if len(sys.argv) > 1 else "8252"
P, F = [], []


def ok(n, c, d=""):
    (P if c else F).append(n)
    print(("  \033[32m✓\033[0m " if c else "  \033[31m✗\033[0m ") + n
          + (f"  \033[90m{d}\033[0m" if d else ""))


MEASURE = """() => {
  const cv = document.querySelector('.sphere-canvas');
  if (!cv) return { err: 'no canvas' };
  const c = cv.getContext('2d');
  const d = c.getImageData(0, 0, cv.width, cv.height).data;
  let ink = 0, sum = 0, r = 0, g = 0, b = 0;
  for (let i = 0; i < d.length; i += 40) {
    if (d[i + 3] > 10) { ink++; sum += (d[i] + d[i+1] + d[i+2]) / 3;
                         r += d[i]; g += d[i+1]; b += d[i+2]; }
  }
  return { ink, mean: ink ? sum / ink : 0,
           r: ink ? r / ink : 0, g: ink ? g / ink : 0, b: ink ? b / ink : 0,
           w: cv.width, h: cv.height };
}"""


async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch(args=[
            "--enable-unsafe-swiftshader", "--no-sandbox", "--use-gl=swiftshader"])
        ctx = await b.new_context(viewport={"width": 1440, "height": 900})
        pg = await ctx.new_page()
        errs = []
        pg.on("pageerror", lambda e: errs.append("PAGEERROR: " + str(e)))
        pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)

        await pg.goto(f"http://127.0.0.1:{PORT}/", wait_until="load")
        await pg.wait_for_selector("#boot-enter:not([hidden])", timeout=45000)
        await pg.click("#boot-enter")
        await pg.wait_for_timeout(3200)
        await pg.evaluate("() => document.querySelectorAll('.setup').forEach(e => e.remove())")
        await pg.wait_for_timeout(800)

        # ── A · the sphere is the default and it renders ──────────────
        print("\n\033[36m▸ A · THE SPHERE IS THE DEFAULT AND IT PAINTS\033[0m")
        a = await pg.evaluate("""() => {
            const m = window.AURA.avatarManager;
            return { provider: m?.provider?.constructor?.id,
                     canvas: !!document.querySelector('.sphere-canvas'),
                     state: m?.getAgentState?.() };
        }""")
        ok("the Sphere provider is active", a["provider"] == "sphere", str(a["provider"]))
        ok("it created a canvas", a["canvas"])
        ok("it starts idle", a["state"] == "idle", str(a["state"]))

        m0 = await pg.evaluate(MEASURE)
        ok("the canvas matches its container, not 1x1",
           m0["w"] > 300 and m0["h"] > 300, f"{m0['w']}x{m0['h']}")
        ok("IT ACTUALLY DRAWS PIXELS", m0["ink"] > 400, f"{m0['ink']} lit samples")
        ok("the pixels are GOLD (r > g > b)",
           m0["r"] > m0["g"] > m0["b"],
           f"r={m0['r']:.0f} g={m0['g']:.0f} b={m0['b']:.0f}")

        # ── B · the theme is black + gold ─────────────────────────────
        print("\n\033[36m▸ B · BLACK + GOLD IDENTITY (§6)\033[0m")
        t = await pg.evaluate("""() => {
            const cs = getComputedStyle(document.documentElement);
            const hex = (v) => v.trim();
            return { accent: hex(cs.getPropertyValue('--accent')),
                     bg0: hex(cs.getPropertyValue('--bg-0')),
                     theme: localStorage.getItem('aura.config.v1') || '' };
        }""")
        def hx(s):
            s = s.lstrip("#")
            return [int(s[i:i+2], 16) for i in (0, 2, 4)] if len(s) == 6 else [0, 0, 0]
        ar, ag, ab = hx(t["accent"])
        br, bg_, bb = hx(t["bg0"])
        ok("the accent is gold (warm, r>g>b)", ar > ag > ab, t["accent"])
        ok("the background is near-black", max(br, bg_, bb) < 26, t["bg0"])

        # ── C · every state renders differently ───────────────────────
        print("\n\033[36m▸ C · EVERY AGENT STATE LOOKS DIFFERENT\033[0m")
        states = ["idle", "listening", "thinking", "planning", "executing",
                  "success", "error", "connecting", "connected"]
        seen = {}
        for s in states:
            acc = await pg.evaluate(
                f"() => window.AURA.avatarManager.setAgentState('{s}')")
            await pg.wait_for_timeout(1400)
            mm = await pg.evaluate(MEASURE)
            seen[s] = mm
            ok(f"{s}: accepted and painting", acc is True and mm["ink"] > 200,
               f"ink={mm['ink']}")

        base = seen["idle"]
        for s in states[1:]:
            mm = seen[s]
            differs = abs(mm["ink"] - base["ink"]) > 120 or abs(mm["mean"] - base["mean"]) > 1.5
            ok(f"{s} is visually distinct from idle", differs,
               f"ink {base['ink']}→{mm['ink']}, mean {base['mean']:.1f}→{mm['mean']:.1f}")

        ok("success is brighter than idle (§11 pulse)",
           seen["success"]["ink"] > seen["idle"]["ink"],
           f"{seen['success']['ink']} vs {seen['idle']['ink']}")
        ok("listening is brighter than idle",
           seen["listening"]["ink"] > seen["idle"]["ink"],
           f"{seen['listening']['ink']} vs {seen['idle']['ink']}")
        # error tilts warm: the red:blue ratio must rise.
        e_ratio = seen["error"]["r"] / max(1, seen["error"]["b"])
        i_ratio = seen["idle"]["r"] / max(1, seen["idle"]["b"])
        ok("error runs hotter/redder than idle", e_ratio > i_ratio,
           f"r/b {i_ratio:.2f} → {e_ratio:.2f}")

        await pg.evaluate("() => window.AURA.avatarManager.setAgentState('idle')")
        await pg.wait_for_timeout(600)

        # ── D · REAL events drive it, not a timer ─────────────────────
        print("\n\033[36m▸ D · REAL EVENTS DRIVE THE SPHERE (§94)\033[0m")
        d = await pg.evaluate("""async () => {
            const { bus } = await import('/js/core/bus.js');
            const m = window.AURA.avatarManager;
            const out = {};
            bus.emit('voice:stt-start', {});
            out.onListen = m.getAgentState();
            bus.emit('voice:stt-end', {});
            bus.emit('ai:stream-start', {});
            out.onThink = m.getAgentState();
            bus.emit('ai:stream-end', {});
            bus.emit('trace:start', { id: 'x1', title: 'Camera · enable' });
            out.onTrace = m.getAgentState();
            bus.emit('trace:end', { id: 'x1', state: 'ok', ms: 5 });
            out.onDone = m.getAgentState();
            bus.emit('trace:start', { id: 'x2', title: 'Planning the task' });
            out.onPlan = m.getAgentState();
            bus.emit('trace:end', { id: 'x2', state: 'fail', ms: 5 });
            out.onFail = m.getAgentState();
            bus.emit('devices:pairing', {});
            out.onPairing = m.getAgentState();
            bus.emit('devices:paired', {});
            out.onPaired = m.getAgentState();
            return out;
        }""")
        ok("microphone start → listening", d["onListen"] == "listening", str(d["onListen"]))
        ok("model stream → thinking", d["onThink"] == "thinking", str(d["onThink"]))
        ok("a tool trace → executing", d["onTrace"] == "executing", str(d["onTrace"]))
        ok("trace success → success pulse", d["onDone"] == "success", str(d["onDone"]))
        ok("a PLANNING trace → planning", d["onPlan"] == "planning", str(d["onPlan"]))
        ok("trace failure → error", d["onFail"] == "error", str(d["onFail"]))
        ok("pairing started → connecting", d["onPairing"] == "connecting", str(d["onPairing"]))
        ok("device paired → connected", d["onPaired"] == "connected", str(d["onPaired"]))

        # ── E · the task card is real ─────────────────────────────────
        print("\n\033[36m▸ E · TASK CARD: PLAN, REAL PROGRESS, CANCEL (§17/§19/§64)\033[0m")
        e = await pg.evaluate("""async () => {
            const { Trace } = await import('/js/core/trace.js');
            const t = new Trace('Presentation', {
              command: 'make me a ppt on brahma ai',
              plan: ['Understand the topic', 'Build a slide structure',
                     'Generate the deck', 'Open the presentation'],
            });
            window.__t = t;
            const card = () => document.querySelector(`.trace[data-id="${t.id}"]`);
            const pct = () => {
              const b = card()?.querySelector('.trace-bar i');
              return b ? parseInt(b.style.width || '0', 10) : -1;
            };
            const out = { exists: !!card(),
                          cmd: card()?.querySelector('.trace-cmd')?.textContent,
                          planCount: card()?.querySelectorAll('.trace-plan li').length,
                          hasCancel: !!card()?.querySelector('.trace-cancel'),
                          p0: pct() };
            t.step('Understood the topic', 'ok');
            out.p1 = pct();
            t.step('Built the structure', 'ok');
            out.p2 = pct();
            out.doneMarks = card().querySelectorAll('.trace-plan li.done').length;
            t.artifact('Presentation', '/home/user/AURA/deck.pptx', 'pptx');
            out.artifacts = card().querySelectorAll('.trace-art').length;
            out.artPath = card().querySelector('.trace-art code')?.textContent;
            return out;
        }""")
        ok("a task card was created", e["exists"])
        ok("it echoes the command", "brahma ai" in (e["cmd"] or ""), str(e["cmd"]))
        ok("it lists the 4-step plan", e["planCount"] == 4, str(e["planCount"]))
        ok("it offers CANCEL while running", e["hasCancel"])
        ok("progress starts at 0%", e["p0"] == 0, str(e["p0"]))
        ok("progress RISES with a real step", e["p1"] > e["p0"], f"{e['p0']}→{e['p1']}")
        ok("and again with the next", e["p2"] > e["p1"], f"{e['p1']}→{e['p2']}")
        ok("completed plan lines are ticked off", e["doneMarks"] == 2, str(e["doneMarks"]))
        ok("an artifact is surfaced (§73)", e["artifacts"] == 1)
        ok("with its real path", "deck.pptx" in (e["artPath"] or ""), str(e["artPath"]))

        e2 = await pg.evaluate("""() => {
            const t = window.__t;
            const card = document.querySelector(`.trace[data-id="${t.id}"]`);
            const before = parseInt(card.querySelector('.trace-bar i').style.width, 10);
            t.end('ok', 'Presentation created.');
            const after = parseInt(card.querySelector('.trace-bar i').style.width, 10);
            return { before, after,
                     cancelGone: !card.querySelector('.trace-cancel'),
                     allDone: card.querySelectorAll('.trace-plan li.done').length };
        }""")
        ok("the bar NEVER hits 100% while running", e2["before"] < 100, str(e2["before"]))
        ok("...and only reaches 100% when the task really ends", e2["after"] == 100)
        ok("CANCEL disappears once finished", e2["cancelGone"])
        ok("every plan line is ticked at the end", e2["allDone"] == 4, str(e2["allDone"]))

        c = await pg.evaluate("""async () => {
            const { Trace } = await import('/js/core/trace.js');
            const { bus } = await import('/js/core/bus.js');
            const t = new Trace('Long job', { command: 'do something slow',
                                              plan: ['a', 'b', 'c'] });
            bus.emit('trace:register', { id: t.id, trace: t });
            const card = document.querySelector(`.trace[data-id="${t.id}"]`);
            card.querySelector('.trace-cancel').click();
            await new Promise(r => setTimeout(r, 120));
            const btn = card.querySelector('.trace-cancel');
            const res = { cancelled: t.cancelled,
                          btnText: btn ? btn.textContent : null,
                          btnDisabled: btn ? btn.disabled : null };
            t.end('ok', 'finished anyway');
            res.finalState = card.querySelector('.trace-dot').className;
            return res;
        }""")
        ok("clicking CANCEL really flags the task", c["cancelled"] is True)
        ok("the button says STOPPING (honest about async)",
           "STOPPING" in (c["btnText"] or ""), str(c["btnText"]))
        ok("the button disables so it cannot be spammed", c["btnDisabled"] is True)
        ok("a cancelled task NEVER reports success",
           "ok" not in c["finalState"], c["finalState"])

        # ── F · performance ───────────────────────────────────────────
        print("\n\033[36m▸ F · PERFORMANCE (§12/§83)\033[0m")
        perf = await pg.evaluate("""async () => {
            const p = window.AURA.avatarManager.provider;
            let frames = 0;
            const t0 = performance.now();
            await new Promise(res => {
              const tick = () => { frames++;
                if (performance.now() - t0 > 2000) return res(null);
                requestAnimationFrame(tick); };
              requestAnimationFrame(tick);
            });
            const secs = (performance.now() - t0) / 1000;
            return { fps: frames / secs, particles: p.particles.length,
                     quality: p.quality };
        }""")
        ok("the render loop keeps a usable frame rate under SwiftShader",
           perf["fps"] > 15, f"{perf['fps']:.1f} fps at {perf['quality']} "
                             f"({perf['particles']} particles)")
        ok("auto-tune kept the particle budget sane",
           0 < perf["particles"] <= 1100, str(perf["particles"]))

        # ── G · reduced motion ────────────────────────────────────────
        print("\n\033[36m▸ G · REDUCED MOTION (§82)\033[0m")
        rm = await pg.evaluate("""async () => {
            const p = window.AURA.avatarManager.provider;
            p.setReducedMotion(true);
            const r0 = p.rot;
            await new Promise(r => setTimeout(r, 700));
            const r1 = p.rot;
            p.setReducedMotion(false);
            await new Promise(r => setTimeout(r, 700));
            const r2 = p.rot;
            return { frozen: Math.abs(r1 - r0) < 1e-6, resumed: r2 > r1 };
        }""")
        ok("reduced motion stops the rotation", rm["frozen"])
        ok("...and it resumes when turned off", rm["resumed"])
        rm2 = await pg.evaluate(MEASURE)
        ok("it still renders while reduced (no blank screen)", rm2["ink"] > 200,
           str(rm2["ink"]))

        # ── H · the humanoid still works ──────────────────────────────
        print("\n\033[36m▸ H · SWITCHING PROVIDERS STILL WORKS\033[0m")
        sw = await pg.evaluate("""async () => {
            const m = window.AURA.avatarManager;
            const r = await m.use('builtin');
            const okSwitch = !!(r && (r.ok ?? true));
            const gone = !document.querySelector('.sphere-canvas');
            const back = await m.use('sphere');
            await new Promise(r2 => setTimeout(r2, 700));
            return { okSwitch, gone, backOk: !!(back && (back.ok ?? true)),
                     canvas: !!document.querySelector('.sphere-canvas') };
        }""")
        ok("can switch to the humanoid", sw["okSwitch"])
        ok("the sphere canvas is cleaned up", sw["gone"])
        ok("can switch back", sw["backOk"])
        ok("and the sphere returns", sw["canvas"])
        m2 = await pg.evaluate(MEASURE)
        ok("it repaints after switching back", m2["ink"] > 300, str(m2["ink"]))

        print("\n\033[36m▸ CONSOLE\033[0m")
        real = [e for e in errs if "favicon" not in e.lower()
                and "swiftshader" not in e.lower() and not e.startswith("INFO:")]
        ok("no console errors", not real, "; ".join(real[:2]))

        await pg.screenshot(path="screenshots/42-sphere-taskcard.png")
        await b.close()

    print(f"\n  \033[32mPASS {len(P)}\033[0m  FAIL {len(F)}")
    if F:
        print("  Failed: " + ", ".join(F))
        sys.exit(1)


asyncio.run(main())
