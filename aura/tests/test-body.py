#!/usr/bin/env python3
"""Full-body avatar + wardrobe + live data + glass UI, in a real browser."""
import asyncio, sys
from playwright.async_api import async_playwright

PORT = sys.argv[1] if len(sys.argv) > 1 else "8050"
ok, bad = [], []

def rec(n, c, d=""):
    (ok if c else bad).append((n, d))
    print(("  \033[32m✓\033[0m " if c else "  \033[31m✗\033[0m ") + n + (f"  \033[90m{d}\033[0m" if d else ""))

async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch(args=[
            "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
            "--enable-unsafe-swiftshader", "--use-gl=swiftshader", "--ignore-gpu-blocklist"])
        ctx = await b.new_context(permissions=["camera", "microphone", "geolocation"],
                                  geolocation={"latitude": 28.67, "longitude": 77.45},
                                  viewport={"width": 1560, "height": 950})
        p = await ctx.new_page()
        errs = []
        p.on("pageerror", lambda e: errs.append(str(e)))
        await p.goto(f"http://localhost:{PORT}/", wait_until="domcontentloaded")
        await p.wait_for_selector("#boot-enter:not([hidden])", timeout=45000)
        blog = await p.eval_on_selector_all("#boot-log li", "e=>e.map(x=>x.textContent)")
        print("  boot:", [l for l in blog if "Avatar" in l])
        await p.click("#boot-enter")
        await p.wait_for_timeout(1500)
        if await p.is_visible(".setup-box"):
            await p.click('[data-act="skip"]')
            await p.wait_for_selector(".setup-box", state="detached", timeout=8000)
        await p.wait_for_timeout(2500)

        # ── full body
        info = await p.evaluate("""()=>{const a=window.AURA.avatar;
            return {isBody:!!a.isBody, ok:a.ok, bones:Object.keys(a.bones||{}).length,
                    garments:(a.garments||[]).length, acc:(a.accessories||[]).length,
                    outfit:a.outfit, palette:a.palette, mode:window.AURA && a.isBody?'body':'other'};}""")
        rec("Full-body avatar is active", info["isBody"] and info["ok"], f"{info['bones']} bones")
        rec("Skeleton has full limb hierarchy", info["bones"] >= 19, str(info["bones"]) + " bones = 5 spine + 7x2 limbs")
        rec("Outfit meshes attached to bones", info["garments"] > 5, f"{info['garments']} garment meshes")
        rec("Accessory rendered", info["acc"] > 0, f"{info['acc']} accessory meshes, outfit={info['outfit']}")

        anim = await p.evaluate("""async ()=>{const a=window.AURA.avatar;
            const b=a.bones.upperArmR, y0=b.rotation.x, h0=a.bones.head.rotation.y;
            await new Promise(r=>setTimeout(r,1000));
            return {arm:Math.abs(a.bones.upperArmR.rotation.x-y0)>0.0005,
                    head:Math.abs(a.bones.head.rotation.y-h0)>0.0005,
                    fps:document.getElementById('stat-fps').textContent};}""")
        rec("Body idle-animates (arms + head)", anim["arm"] and anim["head"], f"{anim['fps']} FPS")

        wave = await p.evaluate("""async ()=>{const bus=(await import('/js/core/bus.js')).bus;
            const a=window.AURA.avatar; const before=a.bones.upperArmR.rotation.x;
            bus.emit('gesture:detected',{gesture:'wave',confidence:.95});
            await new Promise(r=>setTimeout(r,700));
            return {imp:a.impulse.wave, lifted:a.bones.upperArmR.rotation.x < before-0.3,
                    emo:a.emotion};}""")
        rec("WAVE raises the actual arm", wave["lifted"] and wave["imp"] > 0, f"emotion={wave['emo']}")

        cheer = await p.evaluate("""async ()=>{const bus=(await import('/js/core/bus.js')).bus;
            const a=window.AURA.avatar;
            bus.emit('gesture:detected',{gesture:'peace',confidence:.9});
            await new Promise(r=>setTimeout(r,700));
            return {l:a.bones.upperArmL.rotation.x, r:a.bones.upperArmR.rotation.x};}""")
        rec("PEACE raises both arms (cheer)", cheer["l"] < -0.5 and cheer["r"] < -0.5,
            f"L={cheer['l']:.2f} R={cheer['r']:.2f}")

        lip = await p.evaluate("""async ()=>{const bus=(await import('/js/core/bus.js')).bus;
            const a=window.AURA.avatar; a.speaking=true; const h0=a.mouth.h;
            bus.emit('voice:tts-viseme',{visemes:[{viseme:'AI',t:0,dur:400,open:.85}]});
            await new Promise(r=>setTimeout(r,350)); const h1=a.mouth.h; a.speaking=false;
            return {h0,h1,moved:Math.abs(h1-h0)>0.05};}""")
        rec("Body avatar lip-syncs", lip["moved"], f"mouth {lip['h0']:.2f}→{lip['h1']:.2f}")

        # ── wardrobe
        await p.click('.dock-btn[data-panel="wardrobe"]')
        await p.wait_for_timeout(500)
        counts = await p.evaluate("""()=>({o:document.querySelectorAll('[data-outfit]').length,
            p:document.querySelectorAll('[data-palette]').length,
            a:document.querySelectorAll('[data-acc]').length})""")
        rec("Wardrobe UI populated", counts["o"] >= 6 and counts["p"] >= 5 and counts["a"] >= 4,
            f"{counts['o']} outfits · {counts['p']} colours · {counts['a']} accessories")

        swap = await p.evaluate("""async ()=>{
            const before=window.AURA.avatar.outfit;
            document.querySelector('[data-outfit="armor"]').click();
            await new Promise(r=>setTimeout(r,500));
            const g1=(window.AURA.avatar.garments||[]).length;
            document.querySelector('[data-palette="emerald"]').click();
            await new Promise(r=>setTimeout(r,500));
            return {before, after:window.AURA.avatar.outfit, g1,
                    pal:window.AURA.avatar.palette};}""")
        rec("Outfit swap rebuilds garments", swap["after"] == "armor" and swap["g1"] > 5,
            f"{swap['before']} → {swap['after']}, {swap['g1']} meshes")
        rec("Colour palette applies", swap["pal"] == "emerald", swap["pal"])

        persist = await p.evaluate("()=>JSON.parse(localStorage.getItem('aura.config.v1')||'{}')")
        rec("Wardrobe choice persists to config",
            persist.get("avatarOutfit") == "armor" and persist.get("avatarPalette") == "emerald",
            f"{persist.get('avatarOutfit')}/{persist.get('avatarPalette')}")

        await p.screenshot(path="tests/shot-body.png")

        # ── glass UI
        glass = await p.evaluate("""()=>{const h=document.documentElement.classList.contains('glass');
            const s=getComputedStyle(document.querySelector('.panels'));
            return {on:h, blur:s.backdropFilter||s.webkitBackdropFilter};}""")
        rec("Glass UI active with backdrop blur", glass["on"] and "blur" in (glass["blur"] or ""), glass["blur"])

        # ── live data
        await p.evaluate("()=>window.AURA.openPanel('chat')")
        async def ask(msg, wait=9000):
            await p.fill("#input", msg); await p.press("#input", "Enter")
            await p.wait_for_timeout(wait)
            return await p.evaluate("()=>{const m=[...document.querySelectorAll('.msg.assistant')].pop();return m?m.innerText:''}")

        r = await ask("what's the weather in Delhi")
        rec("LIVE weather (real API)", "°C" in r and "Delhi" in r, r[:70].replace("\n", " "))

        r = await ask("bitcoin price")
        rec("LIVE crypto price", "$" in r and "BITCOIN" in r.upper(), r[:60].replace("\n", " "))

        r = await ask("/fx 100 USD INR")
        rec("LIVE currency rate", "INR" in r and "=" in r, r[:60].replace("\n", " "))

        r = await ask("/wiki quantum computing")
        rec("LIVE Wikipedia", "quantum" in r.lower() and len(r) > 100, r[:60].replace("\n", " "))

        r = await ask("tech news", 12000)
        rec("LIVE news feed", "Hacker News" in r or "NEWS" in r.upper(), r[:60].replace("\n", " "))

        # ── offline toggle
        r = await ask("/offline on")
        rec("Offline mode toggles ON", "Offline mode ON" in r, r[:50])
        r = await ask("what's the weather in Delhi")
        rec("Offline mode blocks internet lookups", "Live data is OFF" in r or "off" in r.lower(),
            r[:70].replace("\n", " "))
        r = await ask("/offline off")
        rec("Live data can be re-enabled", "Live data ON" in r, r[:40])

        await p.screenshot(path="tests/shot-live.png")
        rec("No page errors", len(errs) == 0, "; ".join(errs[:1])[:120])
        await b.close()

    print(f"\n  \033[32mPASS {len(ok)}\033[0m / {len(ok)+len(bad)}" + (f"  \033[31mFAIL {len(bad)}\033[0m" if bad else "  ALL GREEN"))
    for n, d in bad: print(f"    ✗ {n} — {d}")
    return 1 if bad else 0

sys.exit(asyncio.run(main()))
