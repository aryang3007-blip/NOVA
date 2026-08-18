#!/usr/bin/env python3
"""Desktop framework in a real browser: settings UI + AI→ActionManager gate."""
import asyncio, sys
from playwright.async_api import async_playwright
PORT = sys.argv[1] if len(sys.argv) > 1 else "8060"
ok, bad = [], []
def rec(n, c, d=""):
    (ok if c else bad).append((n, d))
    print(("  \033[32m✓\033[0m " if c else "  \033[31m✗\033[0m ") + n + (f"  \033[90m{d}\033[0m" if d else ""))

async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch(args=["--use-fake-ui-for-media-stream","--use-fake-device-for-media-stream",
            "--enable-unsafe-swiftshader","--use-gl=swiftshader","--ignore-gpu-blocklist"])
        p = await (await b.new_context(permissions=["camera","microphone"],
                   viewport={"width":1560,"height":950})).new_page()
        errs=[]; p.on("pageerror", lambda e: errs.append(str(e)))
        await p.goto(f"http://localhost:{PORT}/", wait_until="domcontentloaded")
        await p.wait_for_selector("#boot-enter:not([hidden])", timeout=45000)
        blog = await p.eval_on_selector_all("#boot-log li","e=>e.map(x=>x.textContent)")
        print("  boot:", [l for l in blog if "Desktop framework" in l])
        await p.click("#boot-enter"); await p.wait_for_timeout(1500)
        if await p.is_visible(".setup-box"):
            await p.click('[data-act="skip"]'); await p.wait_for_selector(".setup-box",state="detached",timeout=8000)
        await p.wait_for_timeout(2000)

        # Guard: every tabpane must have a matching clickable tab button.
        # A pane was once added without its button, making it unreachable.
        tabs = await p.evaluate("""()=>({
            buttons:[...document.querySelectorAll('.tab')].map(t=>t.dataset.tab),
            panes:[...document.querySelectorAll('.tabpane')].map(t=>t.dataset.tab)})""")
        missing = [x for x in tabs["panes"] if x not in tabs["buttons"]]
        rec("Every settings pane has a tab button", not missing, f"orphaned: {missing}" if missing else f"{len(tabs['buttons'])} tabs")
        rec("DESKTOP tab present", "desktop" in tabs["buttons"])

        st = await p.evaluate("()=>window.AURA.desktop.status()")
        rec("Framework initialised in browser", st["initialized"])
        rec("6 plugins registered", len(st["plugins"])==6, str([x["id"] for x in st["plugins"]]))
        rec("Actions registered", len(st["actions"])>=15, f"{len(st['actions'])} actions")
        # Honest reporting either way: simulated only when there is no host process.
        expected_sim = st["backend"] == "mock"
        rec("Reports backend mode honestly", st["simulated"] is expected_sim,
            f"backend={st['backend']} simulated={st['simulated']}")
        rec("Zero permissions granted at start", st["permissions"]["granted"]==0)

        # AI pipeline: denied without permission
        async def ask(msg, w=3500):
            await p.evaluate("()=>window.AURA.openPanel('chat')")
            await p.fill("#input", msg); await p.press("#input","Enter"); await p.wait_for_timeout(w)
            return await p.evaluate("()=>{const m=[...document.querySelectorAll('.msg.assistant')].pop();return m?m.innerText:''}")

        r = await ask("open whatsapp")
        rec("AI request DENIED without permission", "permission" in r.lower(), r[:75].replace("\n"," "))
        rec("Denial names the fix location", "Settings" in r or "Desktop" in r, r[:60].replace("\n"," "))

        await p.evaluate("()=>window.AURA.desktop.permissions.grant('launch_apps')")
        r = await ask("open whatsapp")
        rec("AI request ALLOWED once granted", "whatsapp" in r.lower(), r[:75].replace("\n"," "))

        r = await ask("what is 47*89")
        rec("Maths still answered, not hijacked", "4,183" in r or "4183" in r, r[:45].replace("\n"," "))

        r = await ask("hello")
        rec("Conversation still conversational", len(r)>5 and "action" not in r.lower(), r[:45].replace("\n"," "))

        # confirmation gate through the AI
        await p.evaluate("()=>window.AURA.desktop.permissions.grant('close_apps')")
        r = await ask("close spotify")
        rec("Destructive action asks for confirmation", "confirm" in r.lower(), r[:70].replace("\n"," "))
        r = await ask("yes")
        rec("Confirming executes it", "spotify" in r.lower() or "simulat" in r.lower(), r[:60].replace("\n"," "))

        # settings UI
        await p.evaluate("()=>window.AURA.openSettings()")
        await p.wait_for_selector("#settings:not([hidden])", timeout=8000)
        await p.evaluate("()=>{for(const t of document.querySelectorAll('.tab')) if(t.dataset.tab==='desktop') t.click();}")
        await p.wait_for_timeout(700)

        ui = await p.evaluate("""()=>({
            apps: document.querySelectorAll('.dt-app').length,
            perms: document.querySelectorAll('[data-perm]').length,
            plugins: document.querySelectorAll('.dt-plugin').length,
            caps: document.querySelectorAll('.dt-cap').length,
            audit: document.querySelectorAll('#dt-audit div').length,
            scanDisabled: document.getElementById('dt-scan').disabled,
            scanLabel: document.getElementById('dt-scan').textContent.trim(),
            statusTxt: document.getElementById('dt-status').innerText.slice(0,60)})""")
        rec("Installed Applications listed", ui["apps"]>=15, f"{ui['apps']} apps")
        # 13 at v0.17; 14 with minimize_windows (v0.18); 15 with vision_mouse (v0.20).
        rec("Desktop Permissions listed", ui["perms"]==15, f"{ui['perms']} toggles")
        rec("Installed Plugins listed", ui["plugins"]==6, f"{ui['plugins']} plugins")
        rec("Integration Status shown", ui["caps"]>=4, ui["statusTxt"])
        rec("Action log populated", ui["audit"]>=1, f"{ui['audit']} entries")
        rec("Scan button present and DISABLED", ui["scanDisabled"] is True, ui["scanLabel"])
        # Renamed to "RESCAN INSTALLED" when the "+ ADD APPLICATION" button
        # was added beside it, so the pair reads as one row of actions.
        rec("Scan button labelled correctly", "RESCAN" in ui["scanLabel"].upper(), ui["scanLabel"])

        await p.screenshot(path="tests/final-11-desktop.png")

        await p.evaluate("()=>window.AURA.renderDesktop()")
        await p.wait_for_timeout(400)
        tog = await p.evaluate("""async ()=>{
            const cb=document.querySelector('[data-perm="clipboard"]');
            if(!cb) return {before:null, after:null, missing:true};
            const before=window.AURA.desktop.permissions.isGranted('clipboard');
            cb.click(); await new Promise(r=>setTimeout(r,300));
            return {before, after: window.AURA.desktop.permissions.isGranted('clipboard')};}""")
        rec("Permission toggle works from UI", tog["before"] != tog["after"])

        search = await p.evaluate("""async ()=>{
            const i=document.getElementById('dt-appsearch');
            i.value='spot'; i.dispatchEvent(new Event('input'));
            await new Promise(r=>setTimeout(r,300));
            return document.querySelectorAll('.dt-app').length;}""")
        rec("App search filters list", 0 < search < ui["apps"], str(search) + " results for spot (was " + str(ui["apps"]) + ")")

        rec("No page errors", len(errs)==0, "; ".join(errs[:1])[:110])
        await b.close()
    print(f"\n  \033[32mPASS {len(ok)}\033[0m / {len(ok)+len(bad)}" + (f"  \033[31mFAIL {len(bad)}\033[0m" if bad else "  ALL GREEN"))
    for n,d in bad: print(f"    ✗ {n} — {d}")
    return 1 if bad else 0
sys.exit(asyncio.run(main()))
