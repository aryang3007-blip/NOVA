import asyncio, sys
PORT = sys.argv[1] if len(sys.argv) > 1 else "8090"
from playwright.async_api import async_playwright
ok,bad=[],[]
def rec(n,c,d=""):
    (ok if c else bad).append((n,d))
    print(("  \033[32m✓\033[0m " if c else "  \033[31m✗\033[0m ")+n+(f"  \033[90m{d}\033[0m" if d else ""))
async def main():
    async with async_playwright() as pw:
        b=await pw.chromium.launch(args=["--use-fake-ui-for-media-stream","--use-fake-device-for-media-stream",
            "--enable-unsafe-swiftshader","--use-gl=swiftshader"])
        p=await (await b.new_context(permissions=["camera","microphone"],viewport={"width":1600,"height":1000})).new_page()
        errs=[];p.on("pageerror",lambda e:errs.append(str(e)))
        await p.goto(f"http://localhost:{PORT}/",wait_until="domcontentloaded")
        await p.wait_for_selector("#boot-enter:not([hidden])",timeout=60000)
        await p.click("#boot-enter"); await p.wait_for_timeout(1500)
        if await p.is_visible(".setup-box"):
            await p.click('[data-act="skip"]'); await p.wait_for_timeout(800)
        await p.wait_for_timeout(2500)
        async def ask(m,w=3500):
            await p.evaluate("()=>window.AURA.openPanel('chat')")
            await p.fill("#input",m); await p.press("#input","Enter"); await p.wait_for_timeout(w)
            return await p.evaluate("()=>{const x=[...document.querySelectorAll('.msg.assistant')].pop();return x?x.innerText:''}")

        print("\n\033[36m▸ GUIDE WORKS WITH NO MODEL\033[0m")
        prov = await p.evaluate("()=>window.AURA.ai.providerLabel")
        rec("Running with no LLM", "Local Core" in prov, prov)
        for q,want,label in [
            ("how do i use this app","Using AURA","Overview"),
            ("how do i set up ollama","ollama.com","Ollama setup"),
            ("how do gestures work","Thumbs up","Gestures"),
            ("is my data private","Never leaves","Privacy"),
            ("nothing is working","selftest","Troubleshooting"),
            ("which model are you using","pick a model","Model routing"),
            ("keyboard shortcuts","Shift+Enter","Shortcuts"),
        ]:
            r=await ask(q)
            rec(label, want.lower() in r.lower(), r[:52].replace("\n"," "))

        print("\n\033[36m▸ GUIDE REFLECTS LIVE STATE\033[0m")
        r=await ask("how do i enable the camera")
        rec("Says camera is off", "camera is off" in r.lower(), r[:50].replace("\n"," "))
        await p.evaluate("()=>window.AURA.enableVision()")
        await p.wait_for_timeout(6000)
        r=await ask("how do i enable the camera")
        rec("Updates to camera live", "camera is live" in r.lower(), r[:55].replace("\n"," "))

        print("\n\033[36m▸ COMMANDS\033[0m")
        r=await ask("/guide")
        rec("/guide works", "Using AURA" in r, r[:45].replace("\n"," "))
        r=await ask("/guide gestures")
        rec("/guide <topic>", "Gesture control" in r, r[:45].replace("\n"," "))
        r=await ask("/models")
        rec("/models handles no-Ollama honestly", "No Ollama models" in r or "INSTALLED" in r, r[:55].replace("\n"," "))
        r=await ask("/pin code qwen2.5-coder:7b")
        rec("/pin reports missing model", "not installed" in r.lower(), r[:50].replace("\n"," "))

        print("\n\033[36m▸ NO REGRESSION\033[0m")
        r=await ask("what is 47*89")
        rec("Maths still works", "4,183" in r, r[:35].replace("\n"," "))
        r=await ask("hello")
        rec("Chat still works", len(r)>10 and "Using AURA" not in r, r[:35].replace("\n"," "))
        r=await ask("what is quantum computing",8000)
        rec("Web lookup still works", "quantum" in r.lower(), r[:40].replace("\n"," "))
        route=await p.evaluate("()=>window.AURA.ai._lastRoute?.route")
        rec("Router functioning", route is not None, str(route))
        rec("No page errors", len(errs)==0, "; ".join(errs[:1])[:100])
        await p.screenshot(path="tests/final-19-guide.png")
        await b.close()
    print(f"\n  \033[32mPASS {len(ok)}\033[0m / {len(ok)+len(bad)}" + (f"  \033[31mFAIL {len(bad)}\033[0m" if bad else "  ALL GREEN"))
    for n,d in bad: print(f"    ✗ {n} — {d}")
    return 1 if bad else 0
sys.exit(asyncio.run(main()))
