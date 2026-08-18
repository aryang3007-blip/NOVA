#!/usr/bin/env python3
"""Setup wizard + Ollama proxy + media diagnostics, driven in a real browser."""
import asyncio, sys, subprocess, time, os
from playwright.async_api import async_playwright

PORT = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1].isdigit() else "8033"
FAKE = "11599"
ok, bad = [], []

def rec(n, c, d=""):
    (ok if c else bad).append(n)
    print(("  \033[32m✓\033[0m " if c else "  \033[31m✗\033[0m ") + n + (f"  \033[90m{d}\033[0m" if d else ""))

async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch(args=[
            "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
            "--enable-unsafe-swiftshader", "--use-gl=swiftshader", "--ignore-gpu-blocklist"])
        ctx = await b.new_context(permissions=["camera", "microphone"],
                                  viewport={"width": 1500, "height": 940})
        p = await ctx.new_page()
        errs = []
        p.on("pageerror", lambda e: errs.append(str(e)))

        # fresh profile => wizard must appear
        await p.goto(f"http://localhost:{PORT}/", wait_until="domcontentloaded")
        await p.wait_for_selector("#boot-enter:not([hidden])", timeout=45000)
        blog = await p.eval_on_selector_all("#boot-log li", "e=>e.map(x=>x.textContent)")
        print("  boot:", [l for l in blog if "Ollama" in l or "Desktop" in l] or "-")
        await p.click("#boot-enter")

        # Ollama is reachable here so the wizard correctly stays hidden.
        # Open it explicitly to exercise the UI.
        auto = await p.evaluate("()=>!!document.querySelector('.setup-box')")
        prov0 = await p.evaluate("()=>window.AURA.ai.resolvedProvider")
        rec("Wizard correctly skipped when a brain is already found", (not auto) and prov0 == "ollama",
            f"auto={auto} provider={prov0}")
        await p.evaluate("()=>window.AURA.setup.open({forced:true})")
        try:
            await p.wait_for_selector(".setup-box", timeout=8000)
            rec("Setup wizard renders", True)
        except Exception:
            rec("Setup wizard renders", False, "did not appear")
            await b.close(); return

        await p.wait_for_timeout(2500)
        await p.screenshot(path="tests/ui-setup.png")

        detected = await p.evaluate("()=>document.querySelector('#setup-ollama').innerText")
        rec("Ollama detected through proxy (no CORS)", "running" in detected.lower(), detected[:70].replace("\n", " "))

        cat = await p.evaluate("""()=>{
            const b=document.querySelector('#setup-ollama');
            const m=document.querySelector('[data-act="show-more"]');
            if(m) m.click();
            return document.querySelectorAll('.model-row').length;}""")
        await p.wait_for_timeout(400)
        cat = await p.evaluate("()=>document.querySelectorAll('.model-row').length")
        rec("Installable fast-model catalog rendered", cat >= 3, f"{cat} models offered")

        sizes = await p.evaluate("""()=>[...document.querySelectorAll('.model-meta')].map(e=>e.textContent)""")
        rec("Models sized for ≤6B hardware", any("3.1B" in s or "1.5B" in s for s in sizes), str(sizes[:2]))

        # real pull with progress, through the proxy
        pull = await p.evaluate("""async ()=>{
            const row=[...document.querySelectorAll('.model-row')].find(r=>r.dataset.model!=='qwen2.5:3b');
            if(!row) return {skipped:true};
            const id=row.dataset.model;
            row.querySelector('[data-act="pull"]').click();
            await new Promise(r=>setTimeout(r,2500));
            return {id, txt:(row.querySelector('.pull-txt')||{}).textContent||'',
                    width:(row.querySelector('.pull-fill')||{}).style?.width||''};}""")
        rec("Model install streams real progress", bool(pull.get("txt")), f"{pull.get('id')} → {pull.get('txt')} bar={pull.get('width')}")

        # after install it should finish setup
        await p.wait_for_timeout(1500)
        gone = await p.evaluate("()=>!document.querySelector('.setup-box')")
        prov = await p.evaluate("()=>window.AURA.ai.resolvedProvider")
        rec("Wizard completes and selects Ollama", gone and prov == "ollama", f"provider={prov}")

        # chat actually streams from (fake) ollama through the proxy
        await p.evaluate("()=>window.AURA.openPanel('chat')")
        await p.fill("#input", "hi there")
        await p.press("#input", "Enter")
        await p.wait_for_timeout(4000)
        reply = await p.evaluate("()=>{const m=[...document.querySelectorAll('.msg.assistant')].pop();return m?m.innerText:''}")
        rec("Chat streams from Ollama via proxy", "AURA ONLINE via proxy" in reply, reply[:60].replace("\n", " "))

        # media diagnostic
        diag = await p.evaluate("()=>window.AURA.runMediaDiagnostic()")
        rec("Media diagnostic reports camera state", "Camera" in diag, diag.split("\n")[0][:60])
        rec("Diagnostic reports secure context", "secure=true" in diag, [l for l in diag.split("\n") if "secure" in l][:1])

        # camera really starts
        await p.evaluate("()=>window.AURA.openPanel('vision')")
        await p.click("#btn-cam-start")
        try:
            await p.wait_for_function("()=>window.AURA.vision.stream!==null", timeout=20000)
            rec("Camera starts after diagnostics", True)
        except Exception:
            rec("Camera starts after diagnostics", False, "no stream")

        # mic permission path
        mic = await p.evaluate("""async ()=>{
            const r = await window.AURA.voice.input.ensurePermission();
            return {granted:r, perm:window.AURA && (await navigator.permissions.query({name:'microphone'})).state};}""")
        rec("Mic permission acquired explicitly", mic["granted"], f"state={mic['perm']}")

        await p.screenshot(path="tests/ui-final.png")
        rec("No page errors", len(errs) == 0, "; ".join(errs[:1])[:100])
        await b.close()

    print(f"\n  \033[32mPASS {len(ok)}\033[0m / {len(ok)+len(bad)}" + (f"  \033[31mFAIL {len(bad)}\033[0m" if bad else "  ALL GREEN"))
    for n in bad: print("    ✗", n)
    return 1 if bad else 0

sys.exit(asyncio.run(main()))
