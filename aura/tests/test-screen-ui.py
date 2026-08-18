"""
AURA :: screen sharing + command palette, in a real browser
===========================================================
Chromium can auto-approve getDisplayMedia with a fake capture surface, so the
whole Copilot-Vision path is exercised for real: share -> grab a frame ->
transcribe with the small model -> answer with the fast model.

    python3 tests/fake-screen-ollama.py &
    python3 serve.py 8061 --allow-actions &
    python3 tests/test-screen-ui.py 8061
"""
import asyncio
import sys
from playwright.async_api import async_playwright

PORT = sys.argv[1] if len(sys.argv) > 1 else "8061"
URL = f"http://127.0.0.1:{PORT}/"
P = []
F = []


def ok(n, c, d=""):
    (P if c else F).append(n)
    print(("  \033[32m✓\033[0m " if c else "  \033[31m✗\033[0m ") + n
          + (f"  \033[90m{d}\033[0m" if d else ""))


async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch(args=[
            "--enable-unsafe-swiftshader", "--no-sandbox",
            # Auto-accept the screen picker and feed a synthetic desktop.
            "--auto-accept-this-tab-capture",
            "--auto-select-desktop-capture-source=Entire screen",
            "--use-fake-ui-for-media-stream",
            "--use-fake-device-for-media-stream",
        ])
        ctx = await b.new_context(permissions=["camera"])
        pg = await ctx.new_page()
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("console", lambda m: errs.append(m.text)
              if m.type == "error" and not m.text.startswith("INFO:") else None)
        await pg.goto(URL, wait_until="load")
        await pg.wait_for_timeout(9000)

        # ────────────────────────────────────────────────── palette
        print("\n\033[36m▸ COMMAND PALETTE\033[0m")
        pal = await pg.evaluate("""async () => {
            const inp = document.getElementById('input');
            inp.focus();
            inp.value = '/';
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            await new Promise(r => setTimeout(r, 200));
            const el = document.querySelector('.cmdp');
            const rows = [...document.querySelectorAll('.cmdp-row')]
                .map(r => r.querySelector('.cmdp-name')?.textContent || '');
            return { visible: el && !el.hidden, count: rows.length, rows };
        }""")
        ok("typing '/' opens the palette", pal["visible"])
        ok("it lists commands", pal["count"] > 0, f"{pal['count']} rows")

        filt = await pg.evaluate("""async () => {
            const inp = document.getElementById('input');
            inp.value = '/cl';
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            await new Promise(r => setTimeout(r, 200));
            return [...document.querySelectorAll('.cmdp-name')].map(r => r.textContent);
        }""")
        ok("filters as you type", all("cl" in r.lower() for r in filt), str(filt))
        ok("/click is offered", any("/click" in r for r in filt), str(filt))

        look = await pg.evaluate("""async () => {
            const inp = document.getElementById('input');
            inp.value = '/loo';
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            await new Promise(r => setTimeout(r, 200));
            return [...document.querySelectorAll('.cmdp-name')].map(r => r.textContent);
        }""")
        ok("/look is discoverable", any("/look" in r for r in look), str(look))

        cur = await pg.evaluate("""async () => {
            const inp = document.getElementById('input');
            inp.value = '/cur';
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            await new Promise(r => setTimeout(r, 200));
            return [...document.querySelectorAll('.cmdp-name')].map(r => r.textContent);
        }""")
        ok("/cursor is discoverable", any("/cursor" in r for r in cur), str(cur))

        at = await pg.evaluate("""async () => {
            const inp = document.getElementById('input');
            inp.value = '@';
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            await new Promise(r => setTimeout(r, 200));
            return [...document.querySelectorAll('.cmdp-name')].map(r => r.textContent);
        }""")
        ok("typing '@' shows mentions", len(at) > 0, str(at[:4]))
        ok("@screen is offered", any("@screen" in r for r in at), str(at))

        # Enter must pick from the palette, not send the message.
        picked = await pg.evaluate("""async () => {
            const inp = document.getElementById('input');
            inp.value = '/curs';
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            await new Promise(r => setTimeout(r, 200));
            inp.dispatchEvent(new KeyboardEvent('keydown',
                { key: 'Enter', bubbles: true, cancelable: true }));
            await new Promise(r => setTimeout(r, 200));
            return { value: inp.value,
                     open: !document.querySelector('.cmdp')?.hidden };
        }""")
        ok("Enter inserts the command", picked["value"].startswith("/cursor"), picked["value"])
        ok("and closes the palette", not picked["open"])

        # REGRESSION: typing a COMPLETE command and hitting Enter must SEND
        # it, not autocomplete it. The first build swallowed "/guide" and the
        # message was silently eaten.
        complete = await pg.evaluate("""async () => {
            const inp = document.getElementById('input');
            inp.focus();
            inp.value = '/guide';
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            await new Promise(r => setTimeout(r, 200));
            const ev = new KeyboardEvent('keydown',
                { key: 'Enter', bubbles: true, cancelable: true });
            inp.dispatchEvent(ev);
            await new Promise(r => setTimeout(r, 400));
            return { after: inp.value,
                     open: !document.querySelector('.cmdp')?.hidden };
        }""")
        # Correct outcome: the composer SENT it, so the box is empty.
        # The bug was the box becoming "/guide " (autocompleted, never sent).
        ok("Enter on a COMPLETE command sends instead of autocompleting",
           complete["after"].strip() == "", f"input left as {complete['after']!r}")
        ok("and the palette closes out of the way", not complete["open"])
        await pg.evaluate("() => { document.getElementById('input').value = ''; }")

        esc = await pg.evaluate("""async () => {
            const inp = document.getElementById('input');
            inp.value = '/';
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            await new Promise(r => setTimeout(r, 150));
            inp.dispatchEvent(new KeyboardEvent('keydown',
                { key: 'Escape', bubbles: true, cancelable: true }));
            await new Promise(r => setTimeout(r, 150));
            const el = document.querySelector('.cmdp');
            inp.value = '';
            return el.hidden;
        }""")
        ok("Escape dismisses it", esc)

        noise = await pg.evaluate("""async () => {
            const inp = document.getElementById('input');
            inp.value = 'email me@example.com';
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            await new Promise(r => setTimeout(r, 150));
            const el = document.querySelector('.cmdp');
            inp.value = '';
            return el.hidden;
        }""")
        ok("an email address does not trigger it", noise)

        # ────────────────────────────────────────────── screen share
        print("\n\033[36m▸ SCREEN SHARE\033[0m")
        started = await pg.evaluate("""async () => {
            const { screenShare } = await import('/js/vision/screen-share.js');
            const r = await screenShare.start();
            return { r, status: screenShare.status() };
        }""")
        ok("getDisplayMedia is supported", started["status"]["supported"])
        ok("sharing starts", started["r"]["ok"], started["r"].get("message", ""))
        ok("a surface is reported", bool(started["status"]["surface"]),
           started["status"]["surface"])

        frame = await pg.evaluate("""async () => {
            const { screenShare } = await import('/js/vision/screen-share.js');
            const f = screenShare.grab();
            const g = screenShare.geometry();
            return { len: f ? f.length : 0, jpeg: !!f && f.startsWith('data:image/jpeg'), g };
        }""")
        ok("a frame is captured", frame["len"] > 1000, f"{frame['len']} bytes")
        ok("frame is JPEG, not multi-MB PNG", frame["jpeg"])
        ok("frame is downscaled to <=1280",
           max(frame["g"]["capturedWidth"], frame["g"]["capturedHeight"]) <= 1280,
           f"{frame['g']['capturedWidth']}x{frame['g']['capturedHeight']}")

        chg = await pg.evaluate("""async () => {
            const { screenShare } = await import('/js/vision/screen-share.js');
            const first = screenShare.changeScore();
            const second = screenShare.changeScore();
            return { first, second };
        }""")
        ok("first frame counts as changed", chg["first"] == 1)
        ok("a static screen scores near zero", chg["second"] < 0.2, str(chg["second"]))

        # ───────────────────────────────────────────── the OCR path
        print("\n\033[36m▸ OCR PIPELINE (small model reads, fast model answers)\033[0m")
        agent = await pg.evaluate("""async () => {
            const { ScreenAgent } = await import('/js/ai/screen-agent.js');
            const { screenShare } = await import('/js/vision/screen-share.js');
            const { config } = await import('/js/core/config.js');
            const app = window.AURA;
            await app.ai.refreshModelRegistry();
            const a = new ScreenAgent({ screen: screenShare, ai: app.ai,
                                        actions: app.actions, config });
            const pick = a.pickOcrModel();
            const t = await a.transcribe(screenShare.grab());
            return { pick, ok: t.ok, model: t.model, ms: t.ms,
                     text: (t.text || '').slice(0, 120) };
        }""")
        if not agent["pick"]:
            ok("an image-capable model is available", False,
               "start tests/fake-screen-ollama.py first — this suite needs it")
            print("\n  \033[31mABORTED: no vision model reachable.\033[0m")
            await b.close()
            sys.exit(1)
        # CHANGED (round 12): quality now outranks size. moondream measured
        # 23 chars in 28s then 0 chars in 40s on the user's real machine, so
        # "smallest" was the wrong objective — it has to actually read text.
        ok("picks a real OCR model, not the tiny captioner",
           agent["pick"]["name"] != "moondream:latest", str(agent["pick"]))
        ok("and it is not flagged weak", not agent["pick"].get("weak"), str(agent["pick"]))
        ok("transcription succeeds", agent["ok"], agent.get("text", ""))
        ok("a capable reader did the reading",
           agent["model"] in ("qwen2.5vl:7b", "gemma4:12b"), str(agent["model"]))
        ok("the frame actually reached it", "1 img" in agent["text"], agent["text"][:80])
        ok("screen text came back", "disk full" in agent["text"], agent["text"][:80])
        ok("transcription is non-trivial", len(agent["text"]) > 20, f"{len(agent['text'])} chars")

        end2end = await pg.evaluate("""async () => {
            const { plugins } = await import('/js/core/plugins.js');
            const app = window.AURA;
            const before = app.ai.memory.all().length;
            await plugins.run('/watch ask what does the error say?');
            await new Promise(r => setTimeout(r, 4000));
            const msgs = app.ai.memory.all();
            return { added: msgs.length - before,
                     last: (msgs[msgs.length - 1]?.content || '').slice(0, 160),
                     shown: (msgs[msgs.length - 2]?.content || '').slice(0, 80) };
        }""")
        ok("/watch ask produces an answer", end2end["added"] > 0, f"+{end2end['added']}")
        ok("the fast chat model answered, not the vision one",
           "gemma2:2b" in end2end["last"], end2end["last"][:90])

        # ─────────────────────────────────────── coordinate refusal
        print("\n\033[36m▸ CLICK SAFETY\033[0m")
        safety = await pg.evaluate("""async () => {
            const { ScreenAgent } = await import('/js/ai/screen-agent.js');
            const { screenShare } = await import('/js/vision/screen-share.js');
            const app = window.AURA;
            const a = new ScreenAgent({ screen: screenShare, ai: app.ai,
                                        actions: app.actions, config: null });
            const real = screenShare.surface;
            screenShare.surface = 'window';
            const refused = await a.locate('Save');
            screenShare.surface = real;
            return { refused, surface: real };
        }""")
        # CHANGED BY DESIGN: locate() now SUCCEEDS on a window share and
        # places AURA's own cursor — only the desktop mapping is refused.
        # Refusing outright made /find useless for the commonest case.
        ok("a window share still locates the target",
           safety["refused"]["ok"], str(safety["refused"])[:90])
        ok("but it is marked not-clickable",
           safety["refused"].get("clickable") is False, str(safety["refused"].get("clickable")))
        ok("and tells the user to share the full screen",
           "entire screen" in (safety["refused"].get("reason") or "").lower(),
           str(safety["refused"].get("reason"))[:80])

        # ──────────────────────────────────────────────── commands
        print("\n\033[36m▸ COMMANDS REGISTERED\033[0m")
        cmds = await pg.evaluate("""async () => {
            const { plugins } = await import('/js/core/plugins.js');
            return plugins.listCommands().map(c => c.name);
        }""")
        for want in ["watch", "screenmode", "find", "do"]:
            ok(f"/{want} exists", want in cmds)

        mode = await pg.evaluate("""async () => {
            const { plugins } = await import('/js/core/plugins.js');
            const a = await plugins.run('/screenmode');
            const b = await plugins.run('/screenmode ocr');
            const c = await plugins.run('/screenmode');
            return [a.output || '', b.output || '', c.output || ''];
        }""")
        ok("/screenmode reports the current mode", "auto" in mode[0].lower(), mode[0][:60])
        ok("/screenmode ocr switches", "ocr" in mode[1].lower(), mode[1][:60])
        ok("the change sticks", "MODE: ocr" in mode[2], mode[2][:50])

        stop = await pg.evaluate("""async () => {
            const { plugins } = await import('/js/core/plugins.js');
            const r = await plugins.run('/watch stop');
            const { screenShare } = await import('/js/vision/screen-share.js');
            return { out: r.output || '', active: screenShare.active };
        }""")
        ok("/watch stop ends the share", not stop["active"], stop["out"][:60])

        real = [e for e in errs if "favicon" not in e.lower()
                and "swiftshader" not in e.lower() and not e.startswith("INFO:")]
        print("\n\033[36m▸ CONSOLE\033[0m")
        ok("no console errors", not real, "; ".join(real[:3]))

        await pg.screenshot(path="screenshots/23-command-palette.png")
        await b.close()

    print(f"\n  \033[32mPASS {len(P)}\033[0m  FAIL {len(F)}")
    if F:
        print("  Failed: " + ", ".join(F))
        sys.exit(1)


asyncio.run(main())
