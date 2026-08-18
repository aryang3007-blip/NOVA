#!/usr/bin/env python3
"""
AURA :: browser tests for the features added after real-world feedback.

Covers, in a real Chromium:
  • gesture tab moved to the top toolbar (still functional)
  • hidden Innovations page: invisible, but unlockable
  • custom application management (add / edit / launch by alias / delete)
  • GPU row hidden in the system monitor
  • WebGL reported honestly
  • transcript trimming (the lag fix) under load
"""
import asyncio
import sys
from playwright.async_api import async_playwright

PORT = sys.argv[1] if len(sys.argv) > 1 else "8961"
pass_n = fail_n = 0


def rec(name, cond, detail=""):
    global pass_n, fail_n
    if cond:
        pass_n += 1
        print(f"  \033[32m✓\033[0m {name}" + (f"  \033[90m{detail}\033[0m" if detail else ""))
    else:
        fail_n += 1
        print(f"  \033[31m✗\033[0m {name}  \033[90m{detail}\033[0m")


async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch(args=["--no-sandbox", "--enable-unsafe-swiftshader"])
        page = await (await b.new_context()).new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(f"console: {m.text}") if m.type == "error" else None)

        await page.goto(f"http://localhost:{PORT}/", wait_until="domcontentloaded")
        # The UI sits behind a boot screen until the operator presses ENTER —
        # that gesture is also what unlocks Web Audio. Without it the whole
        # .app container stays display:none and every element measures 0x0.
        await page.wait_for_selector("#boot-enter:not([hidden])", timeout=60000)
        await page.click("#boot-enter")
        await page.wait_for_timeout(1500)
        try:
            await page.click('[data-act="skip"]', timeout=5000)
        except Exception:
            pass
        await page.wait_for_function("()=>window.AURA && window.AURA.desktop", timeout=30000)
        await page.wait_for_timeout(2000)

        print("\n\033[36m▸ GESTURE TAB RELOCATION\033[0m")
        in_dock = await page.evaluate("()=>!!document.querySelector('.dock .dock-btn[data-panel=\"gestures\"]')")
        in_bar = await page.evaluate("()=>!!document.querySelector('.tb-right [data-panel=\"gestures\"]')")
        rec("removed from the right/left dock", not in_dock)
        rec("present in the top toolbar", in_bar)
        await page.click('.tb-right [data-panel="gestures"]')
        await page.wait_for_timeout(400)
        active = await page.evaluate("()=>document.querySelector('.panel[data-panel=\"gestures\"]').classList.contains('active')")
        rec("still opens the gestures panel", active)

        print("\n\033[36m▸ HIDDEN INNOVATIONS PAGE\033[0m")
        btn = await page.evaluate("()=>!!document.querySelector('button[data-panel=\"innovations\"]')")
        rec("no button anywhere in the UI", not btn)
        helped = await page.evaluate("""async()=>{
          const {plugins}=await import('/js/core/plugins.js');
          return plugins.listCommands().map(c=>c.name);
        }""")
        rec("absent from the command list (/help)", "innovations" not in helped)
        rec("but runnable when you know it", await page.evaluate(
            "async()=>{const {plugins}=await import('/js/core/plugins.js');return plugins.has('innovations');}"))

        # unlock by typing the secret sequence
        await page.click("body")
        for ch in "aura":
            await page.keyboard.press(ch)
        await page.wait_for_timeout(800)
        unlocked = await page.evaluate("()=>document.querySelector('.panel[data-panel=\"innovations\"]').classList.contains('active')")
        rec("unlock sequence opens the page", unlocked)
        count = await page.evaluate("()=>document.querySelectorAll('#innovations-body .innov').length")
        rec("ideas are rendered", count >= 10, f"{count} ideas")
        honest = await page.evaluate("()=>document.getElementById('innovations-body').textContent.includes('Still missing')")
        rec("each idea states what is still missing", honest)

        print("\n\033[36m▸ CUSTOM APPLICATIONS\033[0m")
        await page.evaluate("()=>window.AURA.openSettings()")
        await page.wait_for_timeout(400)
        await page.click('.tab[data-tab="desktop"]')
        await page.wait_for_timeout(500)

        rec("ADD APPLICATION button exists", await page.evaluate("()=>!!document.getElementById('dt-app-add')"))
        await page.click("#dt-app-add")
        await page.wait_for_timeout(300)
        rec("form opens", await page.evaluate("()=>!document.getElementById('dt-app-form').hidden"))

        await page.fill("#dt-app-name", "Obsidian")
        await page.fill("#dt-app-aliases", "notes, vault")
        await page.fill("#dt-app-web", "https://obsidian.md")
        await page.click("#dt-app-save")
        await page.wait_for_timeout(600)

        added = await page.evaluate("()=>window.AURA.desktop.database.get('obsidian')")
        rec("custom app is stored", bool(added), str(added and added.get("name")))
        rec("aliases saved", added and "notes" in (added.get("aliases") or []))
        resolved = await page.evaluate("()=>window.AURA.desktop.database.resolve('vault')?.id")
        rec("resolves by a custom alias", resolved == "obsidian", str(resolved))
        rec("form closed after save", await page.evaluate("()=>document.getElementById('dt-app-form').hidden"))
        listed = await page.evaluate("()=>document.querySelector('#dt-apps [data-app-id=\"obsidian\"]')!==null")
        rec("appears in the list", listed)

        # edit it
        await page.click('#dt-apps [data-edit="obsidian"]')
        await page.wait_for_timeout(300)
        rec("edit prefills the name",
            (await page.input_value("#dt-app-name")) == "Obsidian")
        await page.fill("#dt-app-aliases", "notes, vault, brain")
        await page.click("#dt-app-save")
        await page.wait_for_timeout(500)
        rec("edited alias resolves",
            (await page.evaluate("()=>window.AURA.desktop.database.resolve('brain')?.id")) == "obsidian")

        # reject a bad url
        await page.click('#dt-apps [data-edit="obsidian"]')
        await page.wait_for_timeout(300)
        await page.fill("#dt-app-web", "javascript:alert(1)")
        await page.click("#dt-app-save")
        await page.wait_for_timeout(400)
        rec("javascript: URL rejected with a visible error",
            await page.evaluate("()=>!document.getElementById('dt-app-error').hidden"))

        print("\n\033[36m▸ SYSTEM MONITOR / WEBGL\033[0m")
        gpu_shown = await page.evaluate("""()=>{
          const el=[...document.querySelectorAll('#cc-system, .cc-bar-label, .cc-bar')].map(x=>x.textContent).join(' ');
          return /GPU/.test(el);
        }""")
        rec("integrated GPU row hidden by default", not gpu_shown)

        await page.click('.tab[data-tab="about"]')
        await page.wait_for_timeout(500)
        about = await page.evaluate("()=>document.getElementById('about-body').textContent")
        rec("WebGL reported as available (it works)", "WebGL avatar: ✓" in about,
            [l for l in about.split("\n") if "WebGL" in l][:1])
        rec("WebXR explains WHY it's unavailable",
            "no immersive-AR device" in about or "no WebXR API" in about)

        print("\n\033[36m▸ TRANSCRIPT TRIM (lag fix)\033[0m")
        await page.evaluate("()=>window.AURA.closeSettings && window.AURA.closeSettings()")
        await page.evaluate("()=>{for(let i=0;i<400;i++) window.AURA.pushSystemMessage('spam '+i);}")
        await page.wait_for_timeout(700)
        nodes = await page.evaluate("()=>document.getElementById('transcript').children.length")
        rec("transcript is capped under load", nodes <= 240, f"{nodes} nodes after 400 messages")

        print("\n\033[36m▸ ERRORS\033[0m")
        real = [e for e in errors if "favicon" not in e.lower()]
        rec("no page errors", not real, "; ".join(real)[:120])

        await b.close()

    print(f"\n  \033[32mPASS {pass_n}\033[0m  " + (f"\033[31mFAIL {fail_n}\033[0m" if fail_n else "FAIL 0"))
    sys.exit(1 if fail_n else 0)


asyncio.run(main())
