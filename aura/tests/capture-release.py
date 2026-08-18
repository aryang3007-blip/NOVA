#!/usr/bin/env python3
"""
Release screenshot capture.

Also dumps the RAW camera frame AURA receives, so there is no ambiguity about
what the vision system is actually looking at in this environment.
"""
import asyncio, sys, base64
from playwright.async_api import async_playwright

PORT = sys.argv[1] if len(sys.argv) > 1 else "8100"
OUT = "screenshots"


async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch(args=[
            "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
            "--enable-unsafe-swiftshader", "--use-gl=swiftshader", "--ignore-gpu-blocklist"])
        ctx = await b.new_context(
            permissions=["camera", "microphone", "geolocation"],
            geolocation={"latitude": 28.67, "longitude": 77.45},
            viewport={"width": 1600, "height": 1000})
        p = await ctx.new_page()
        errs = []
        p.on("pageerror", lambda e: errs.append(str(e)))

        await p.goto(f"http://localhost:{PORT}/", wait_until="domcontentloaded")
        await p.wait_for_selector("#boot-enter:not([hidden])", timeout=60000)
        await p.screenshot(path=f"{OUT}/01-boot.png")
        print("  01 boot")

        await p.click("#boot-enter")
        await p.wait_for_timeout(1500)
        if await p.is_visible(".setup-box"):
            await p.screenshot(path=f"{OUT}/02-setup-wizard.png")
            print("  02 setup wizard")
            await p.click('[data-act="skip"]')
            await p.wait_for_selector(".setup-box", state="detached", timeout=8000)
        await p.wait_for_timeout(3000)

        # grant a permission so the desktop panels show both states
        await p.evaluate("()=>window.AURA.desktop.permissions.grant('launch_apps')")

        async def ask(m, w=3500):
            await p.evaluate("()=>window.AURA.openPanel('chat')")
            await p.fill("#input", m)
            await p.press("#input", "Enter")
            await p.wait_for_timeout(w)

        await ask("how do i use this app")
        await p.screenshot(path=f"{OUT}/03-chat-guide.png")
        print("  03 built-in guide")

        await ask("what is 47*89")
        await ask("weather in Delhi", 8000)
        await p.screenshot(path=f"{OUT}/04-chat-live-data.png")
        print("  04 maths + live weather")

        # ── VISION: enable the camera and capture what AURA actually sees
        await p.evaluate("()=>window.AURA.openPanel('vision')")
        await p.click("#btn-cam-start")
        try:
            await p.wait_for_function("()=>window.AURA.vision.stream!==null", timeout=30000)
        except Exception:
            print("  !! camera did not start")
        await p.wait_for_timeout(9000)

        await p.screenshot(path=f"{OUT}/05-vision-panel.png")
        print("  05 vision panel")

        # RAW frame straight off the <video> element — the literal camera input.
        raw = await p.evaluate("""() => {
            const v = document.getElementById('video');
            if (!v || !v.videoWidth) return null;
            const c = document.createElement('canvas');
            c.width = v.videoWidth; c.height = v.videoHeight;
            c.getContext('2d').drawImage(v, 0, 0);
            return { data: c.toDataURL('image/png'), w: v.videoWidth, h: v.videoHeight };
        }""")
        if raw:
            with open(f"{OUT}/06-camera-raw-feed.png", "wb") as f:
                f.write(base64.b64decode(raw["data"].split(",")[1]))
            print(f"  06 RAW camera frame ({raw['w']}x{raw['h']})")

        # Frame + detection overlay composited, as the AI sees it
        snap = await p.evaluate("()=>window.AURA.vision.snapshot()")
        if snap:
            with open(f"{OUT}/07-camera-with-overlay.png", "wb") as f:
                f.write(base64.b64decode(snap.split(",")[1]))
            print("  07 camera + detection overlay")

        scene = await p.evaluate("()=>window.AURA.vision.describeScene()")
        print(f"     AURA's own description: {scene.get('description','(none)')}")

        # ── remaining panels
        await p.evaluate("()=>window.AURA.openPanel('ops')")
        await p.wait_for_timeout(1800)
        await p.screenshot(path=f"{OUT}/08-command-center.png")
        print("  08 command center")

        await p.evaluate("()=>{const s=document.querySelector('.cc-scroll'); s.scrollTop=s.scrollHeight;}")
        await p.wait_for_timeout(700)
        await p.screenshot(path=f"{OUT}/09-command-center-lower.png")
        print("  09 command center (memory + plugins)")

        await p.evaluate("()=>window.AURA.openPanel('gestures')")
        await p.wait_for_timeout(600)
        await p.screenshot(path=f"{OUT}/10-gestures.png")
        print("  10 gesture reference")

        await p.evaluate("""()=>{window.AURA.avatar.applyOutfit?.('jacket','violet');
                               window.AURA.avatar.applyAccessory?.('halo');}""")
        await p.wait_for_timeout(900)
        await p.evaluate("()=>window.AURA.openPanel('wardrobe')")
        await p.wait_for_timeout(700)
        await p.screenshot(path=f"{OUT}/11-wardrobe.png")
        print("  11 wardrobe")

        await p.evaluate("()=>window.AURA.openPanel('ops')")
        await p.wait_for_timeout(800)
        await p.screenshot(path=f"{OUT}/12-system.png")
        print("  12 system diagnostics")

        await p.evaluate("()=>window.AURA.openSettings()")
        await p.wait_for_selector("#settings:not([hidden])", timeout=8000)
        await p.wait_for_timeout(500)
        await p.screenshot(path=f"{OUT}/13-settings-ai.png")
        print("  13 settings: AI core")

        await p.evaluate("()=>{for(const t of document.querySelectorAll('.tab')) if(t.dataset.tab==='desktop') t.click();}")
        await p.wait_for_timeout(800)
        await p.screenshot(path=f"{OUT}/14-settings-desktop.png")
        print("  14 settings: desktop integration")

        await p.evaluate("()=>{for(const t of document.querySelectorAll('.tab')) if(t.dataset.tab==='connect') t.click();}")
        await p.wait_for_timeout(700)
        await p.screenshot(path=f"{OUT}/15-settings-connect.png")
        print("  15 settings: connect")
        await p.evaluate("()=>window.AURA.closeSettings()")

        # gesture reaction on the avatar
        await p.evaluate("""async ()=>{const bus=(await import('/js/core/bus.js')).bus;
            bus.emit('gesture:detected',{gesture:'wave',confidence:.95});}""")
        await p.wait_for_timeout(900)
        await p.evaluate("()=>window.AURA.openPanel('chat')")
        await p.wait_for_timeout(400)
        await p.screenshot(path=f"{OUT}/16-avatar-gesture.png")
        print("  16 avatar reacting to a gesture")

        # mobile
        await p.set_viewport_size({"width": 412, "height": 900})
        await p.wait_for_timeout(1400)
        await p.screenshot(path=f"{OUT}/17-mobile.png")
        print("  17 mobile layout")

        print(f"\n  page errors: {errs[:2] if errs else 'none'}")
        await b.close()

asyncio.run(main())
