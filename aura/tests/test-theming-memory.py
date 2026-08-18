#!/usr/bin/env python3
"""
AURA :: Appearance engine, Memory Center, OPS/SYSTEM merge, spring bones

Verifies the four features requested after the avatar work:
  1. Expanded UI theming — presets, backgrounds, sliders, widget visibility
  2. ChatGPT-style memory management — search, edit, pin, delete
  3. OPS + SYSTEM merged into one System Center with nothing lost
  4. VRM spring-bone physics on an imported model
"""
import asyncio
import sys
from playwright.async_api import async_playwright

PORT = sys.argv[1] if len(sys.argv) > 1 else "9201"
pass_n = fail_n = 0


def rec(name, cond, detail=""):
    global pass_n, fail_n
    if cond:
        pass_n += 1
        print(f"  \033[32m✓\033[0m {name}" + (f"  \033[90m{detail}\033[0m" if detail else ""))
    else:
        fail_n += 1
        print(f"  \033[31m✗\033[0m {name}  \033[90m{detail}\033[0m")


# A rigged GLB with a hair chain, so spring bones have something to simulate.
BUILD_HAIR_GLB = """
async () => {
  const THREE = await import('/vendor/three.module.js');
  const hips = new THREE.Bone(); hips.name = 'J_Bip_C_Hips';
  const head = new THREE.Bone(); head.name = 'J_Bip_C_Head'; head.position.y = .8;
  hips.add(head);
  // A four-link hair chain hanging off the head.
  let parent = head;
  for (let i = 1; i <= 4; i++) {
    const b = new THREE.Bone();
    b.name = 'Hair_L_' + i;
    b.position.y = -0.08;
    parent.add(b); parent = b;
  }
  const geo = new THREE.BoxGeometry(.3, 1.6, .2);
  const si = [], sw = [];
  for (let i = 0; i < geo.attributes.position.count; i++) { si.push(0,0,0,0); sw.push(1,0,0,0); }
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
  const mesh = new THREE.SkinnedMesh(geo, new THREE.MeshStandardMaterial({color:0x99aaff}));
  const all = []; hips.traverse(b => all.push(b));
  mesh.add(hips); mesh.bind(new THREE.Skeleton(all));
  const scene = new THREE.Scene(); scene.add(mesh);
  const { GLTFExporter } = await import('/vendor/loaders/GLTFExporter.js');
  const buf = await new Promise((res, rej) =>
    new GLTFExporter().parse(scene, res, rej, { binary: true }));
  window.__hairGlb = new Blob([buf], { type: 'model/gltf-binary' });
  return { bytes: buf.byteLength, bones: all.length };
}
"""


async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch(args=["--no-sandbox", "--enable-unsafe-swiftshader"])
        page = await (await b.new_context(viewport={"width": 1400, "height": 950})).new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(f"console: {m.text}") if m.type == "error" else None)

        await page.goto(f"http://localhost:{PORT}/", wait_until="domcontentloaded")
        await page.wait_for_selector("#boot-enter:not([hidden])", timeout=60000)
        await page.click("#boot-enter")
        await page.wait_for_timeout(1500)
        try:
            await page.click('[data-act="skip"]', timeout=5000)
        except Exception:
            pass
        await page.wait_for_function("()=>window.AURA && window.AURA.avatarManager", timeout=30000)
        await page.wait_for_timeout(2500)

        # ── 1. OPS / SYSTEM MERGE ─────────────────────────────────────────
        print("\n\033[36m▸ OPS + SYSTEM MERGED\033[0m")
        merge = await page.evaluate("""()=>({
          opsBtn: !!document.querySelector('[data-panel="ops"]'),
          sysBtn: !!document.querySelector('[data-panel="system"]'),
          sysPanel: !!document.querySelector('.panel[data-panel="system"]'),
          readout: !!document.getElementById('sys-readout'),
          eventLog: !!document.getElementById('event-log'),
          selftest: !!document.getElementById('btn-selftest'),
          ccSystem: !!document.getElementById('cc-system'),
          ccMemory: !!document.getElementById('cc-memory'),
        })""")
        rec("single System Center button", merge["opsBtn"] and not merge["sysBtn"])
        rec("duplicate SYSTEM panel removed", not merge["sysPanel"])
        rec("diagnostics readout preserved", merge["readout"])
        rec("event log preserved", merge["eventLog"])
        rec("self-test button preserved", merge["selftest"])
        rec("command-center blocks preserved", merge["ccSystem"] and merge["ccMemory"])

        alias = await page.evaluate("""()=>{
          window.AURA.openPanel('system');            // legacy call site
          const ops = document.querySelector('.panel[data-panel="ops"]');
          return ops.classList.contains('active');
        }""")
        rec("openPanel('system') still works (aliased)", alias)

        # ── 2. THEMING ────────────────────────────────────────────────────
        print("\n\033[36m▸ APPEARANCE ENGINE\033[0m")
        await page.evaluate("()=>window.AURA.openSettings()")
        await page.wait_for_timeout(400)
        await page.click('.tab[data-tab="appearance"]')
        await page.wait_for_timeout(700)

        ui = await page.evaluate("""()=>({
          presets: document.querySelectorAll('#thm-presets [data-preset]').length,
          bgs: document.querySelectorAll('#thm-backgrounds [data-background]').length,
          densities: document.querySelectorAll('#thm-densities [data-density]').length,
          huds: document.querySelectorAll('#thm-huds [data-hudStyle]').length,
          sliders: document.querySelectorAll('#thm-sliders [data-tunable]').length,
          widgets: document.querySelectorAll('#thm-widgets [data-widget]').length,
        })""")
        rec("theme presets rendered", ui["presets"] >= 10, f"{ui['presets']} presets")
        rec("background options rendered", ui["bgs"] >= 6, f"{ui['bgs']}")
        rec("density options rendered", ui["densities"] >= 3, f"{ui['densities']}")
        rec("HUD styles rendered", ui["huds"] >= 4, f"{ui['huds']}")
        rec("fine-tune sliders rendered", ui["sliders"] >= 8, f"{ui['sliders']} sliders")
        rec("widget toggles rendered", ui["widgets"] >= 7, f"{ui['widgets']}")

        # Switching a preset must change the live CSS variable.
        theme = await page.evaluate("""async()=>{
          const root = document.documentElement;
          const before = getComputedStyle(root).getPropertyValue('--accent').trim();
          document.querySelector('[data-preset="aura-matrix"]').click();
          await new Promise(r=>setTimeout(r,150));
          const after = getComputedStyle(root).getPropertyValue('--accent').trim();
          return {before, after, attr: root.getAttribute('data-theme')};
        }""")
        rec("preset changes --accent live",
            theme["before"] != theme["after"], f"{theme['before']} -> {theme['after']}")
        rec("data-theme attribute follows", theme["attr"] == "aura-matrix")

        slider = await page.evaluate("""async()=>{
          const el = document.querySelector('[data-tunable="cornerRadius"]');
          el.value = 0; el.dispatchEvent(new Event('input', {bubbles:true}));
          await new Promise(r=>setTimeout(r,120));
          const r0 = getComputedStyle(document.documentElement).getPropertyValue('--r').trim();
          el.value = 26; el.dispatchEvent(new Event('input', {bubbles:true}));
          await new Promise(r=>setTimeout(r,120));
          const r26 = getComputedStyle(document.documentElement).getPropertyValue('--r').trim();
          return {r0, r26};
        }""")
        rec("slider drives a CSS variable live",
            slider["r0"] == "0px" and slider["r26"] == "26px", f"{slider['r0']} / {slider['r26']}")

        blur = await page.evaluate("""async()=>{
          const el = document.querySelector('[data-tunable="glassBlur"]');
          el.value = 0; el.dispatchEvent(new Event('input', {bubbles:true}));
          await new Promise(r=>setTimeout(r,120));
          return getComputedStyle(document.documentElement).getPropertyValue('--glass-blur').trim();
        }""")
        rec("glass blur is adjustable", blur == "0px", blur)

        widget = await page.evaluate("""async()=>{
          document.querySelector('[data-widget="dockLabels"]').click();
          await new Promise(r=>setTimeout(r,150));
          const attr = document.documentElement.getAttribute('data-hide-docklabels');
          const lbl = document.querySelector('.dock-lbl');
          const hidden = lbl ? getComputedStyle(lbl).display === 'none' : null;
          return {attr, hidden};
        }""")
        rec("hiding a widget sets the attribute", widget["attr"] == "true")
        rec("hidden widget is actually not displayed", widget["hidden"] is True)

        light = await page.evaluate("""async()=>{
          document.querySelector('[data-preset="aura-light"]').click();
          await new Promise(r=>setTimeout(r,180));
          const cs = getComputedStyle(document.documentElement);
          return {light: document.documentElement.getAttribute('data-light'),
                  text: cs.getPropertyValue('--text').trim()};
        }""")
        rec("light theme sets data-light", light["light"] == "true")
        rec("light theme uses dark text", light["text"].lower() in ("#0f172a", "rgb(15, 23, 42)"), light["text"])

        reset = await page.evaluate("""async()=>{
          document.getElementById('thm-reset').click();
          await new Promise(r=>setTimeout(r,200));
          const cs = getComputedStyle(document.documentElement);
          return {theme: document.documentElement.getAttribute('data-theme'),
                  r: cs.getPropertyValue('--r').trim()};
        }""")
        rec("reset restores defaults", reset["theme"] == "aura-blue" and reset["r"] == "14px",
            f"{reset['theme']} / {reset['r']}")

        # ── 3. MEMORY CENTER ──────────────────────────────────────────────
        print("\n\033[36m▸ MEMORY CENTER\033[0m")
        await page.evaluate("""()=>{
          const m = window.AURA.ai.memory;
          m.clear();
          m.addUser('my name is Aryan and I live in Delhi');
          m.addAssistant('Nice to meet you, Aryan.');
          m.addUser('what is the capital of France');
          m.addAssistant('Paris.');
        }""")
        await page.click('.tab[data-tab="memory"]')
        await page.wait_for_timeout(700)

        listed = await page.evaluate("()=>document.querySelectorAll('#mem-list .mem-item').length")
        rec("conversation is listed", listed == 4, f"{listed} items")

        # The stats badge must agree with the list — it previously read from a
        # different store and showed "0 MSG" beside four visible messages.
        badge = await page.evaluate("()=>document.getElementById('mem-stats').textContent")
        rec("stats badge matches the list", badge.startswith("4 MSG"), badge)

        search = await page.evaluate("""async()=>{
          const s = document.getElementById('mem-search');
          s.value = 'Aryan'; s.dispatchEvent(new Event('input', {bubbles:true}));
          await new Promise(r=>setTimeout(r,250));
          const n = document.querySelectorAll('#mem-list .mem-item').length;
          s.value = ''; s.dispatchEvent(new Event('input', {bubbles:true}));
          await new Promise(r=>setTimeout(r,250));
          return n;
        }""")
        rec("search filters memory", search == 2, f"{search} hits for 'Aryan'")

        pin = await page.evaluate("""async()=>{
          const row = document.querySelector('#mem-list .mem-item');
          row.querySelector('[data-act="pin"]').click();
          await new Promise(r=>setTimeout(r,300));
          const m = window.AURA.ai.memory;
          return {pinned: m.pinnedMessages().length,
                  inWindow: JSON.stringify(m.window()).includes('Aryan')};
        }""")
        rec("pinning a message works", pin["pinned"] == 1)
        rec("pinned message is in the model context", pin["inWindow"])

        survives = await page.evaluate("""()=>{
          const m = window.AURA.ai.memory;
          for (let i=0;i<700;i++) { m.addUser('noise'+i); m.addAssistant('r'+i); }
          return {pinned: m.pinnedMessages().length,
                  inWindow: JSON.stringify(m.window()).includes('Aryan'),
                  total: m.messages.length};
        }""")
        rec("pin survives 1400 messages of churn",
            survives["pinned"] == 1, f"{survives['total']} msgs retained")
        rec("pinned text STILL reaches the model", survives["inWindow"])

        await page.evaluate("""()=>{
          const m = window.AURA.ai.memory; m.clear();
          m.addUser('editable message'); m.addAssistant('reply');
        }""")
        await page.evaluate("()=>window.AURA.renderMemory()")
        await page.wait_for_timeout(400)

        edit = await page.evaluate("""async()=>{
          const row = document.querySelector('#mem-list .mem-item');
          const btn = row.querySelector('[data-act="edit"]');
          btn.click(); await new Promise(r=>setTimeout(r,120));
          const txt = row.querySelector('[data-text]');
          const editable = txt.getAttribute('contenteditable') === 'true';
          txt.textContent = 'CHANGED BY USER';
          btn.click(); await new Promise(r=>setTimeout(r,300));
          return {editable, content: window.AURA.ai.memory.messages.map(m=>m.content)};
        }""")
        rec("edit makes the row editable", edit["editable"])
        rec("edit persists to memory", "CHANGED BY USER" in edit["content"], str(edit["content"]))

        delete = await page.evaluate("""async()=>{
          const before = window.AURA.ai.memory.messages.length;
          document.querySelector('#mem-list .mem-item [data-act="del"]').click();
          await new Promise(r=>setTimeout(r,300));
          return {before, after: window.AURA.ai.memory.messages.length};
        }""")
        rec("delete removes one message",
            delete["after"] == delete["before"] - 1, f"{delete['before']} -> {delete['after']}")

        learn = await page.evaluate("""async()=>{
          const el = document.getElementById('mem-new');
          el.value = 'I prefer 24-hour time and work in IST';
          document.getElementById('mem-add').click();
          await new Promise(r=>setTimeout(r,600));
          const docs = await window.AURA.memoryManager.knowledge.all();
          const ctx = await window.AURA.memoryManager.buildContext('what time is it');
          return {count: docs.length, recalled: ctx.includes('24-hour')};
        }""")
        rec("teaching AURA stores knowledge", learn["count"] >= 1, f"{learn['count']} docs")
        rec("stored knowledge is recalled in context", learn["recalled"])

        tabs = await page.evaluate("""async()=>{
          const out = {};
          for (const t of ['pinned','facts','knowledge','conversation']) {
            document.querySelector(`[data-memtab="${t}"]`).click();
            await new Promise(r=>setTimeout(r,220));
            out[t] = document.querySelectorAll('#mem-list .mem-item, #mem-list .mem-empty').length > 0;
          }
          return out;
        }""")
        rec("all four memory tabs render", all(tabs.values()), str(tabs))

        # ── 4. SPRING BONES ───────────────────────────────────────────────
        print("\n\033[36m▸ VRM SPRING BONES\033[0m")
        await page.evaluate("()=>window.AURA.closeSettings && window.AURA.closeSettings()")
        built = await page.evaluate(BUILD_HAIR_GLB)
        rec("built a rigged GLB with a hair chain",
            built["bytes"] > 500, f"{built['bytes']} bytes, {built['bones']} bones")

        imported = await page.evaluate("""async()=>{
          const f = new File([window.__hairGlb], 'hair-test.glb', {type:'model/gltf-binary'});
          const r = await window.AURA.avatarManager.importModel(f);
          const p = window.AURA.avatarManager.provider;
          return {ok:r.ok, reason:r.reason, info: p.springInfo,
                  desc: p.springs ? p.springs.describe() : null};
        }""")
        rec("model with hair imports", imported["ok"], str(imported.get("reason")))
        rec("spring bones detected",
            imported["desc"] and imported["desc"]["joints"] >= 3,
            str(imported.get("info")))
        rec("detection source reported",
            imported["desc"] and imported["desc"]["source"] in ("auto", "vrm0", "vrm1"),
            str(imported["desc"]["source"] if imported["desc"] else None))

        # The real test: does the hair MOVE when the avatar does?
        motion = await page.evaluate("""async()=>{
          const {bus, EV} = await import('/js/core/bus.js');
          const m = window.AURA.avatarManager;
          const sp = m.provider.springs;
          const j = sp.joints[sp.joints.length - 1];
          const start = j.cur.clone();
          bus.emit(EV.GESTURE, {gesture:'wave', confidence:.95});
          let maxDelta = 0;
          for (let i=0;i<90;i++) {
            m.provider.applyPose(m.engine.update(1/60));
            maxDelta = Math.max(maxDelta, j.cur.distanceTo(start));
          }
          return {maxDelta, joints: sp.joints.length};
        }""")
        rec("hair physically swings when the avatar moves",
            motion["maxDelta"] > 0.0005, f"max displacement {motion['maxDelta']:.5f}")

        stable = await page.evaluate("""()=>{
          const sp = window.AURA.avatarManager.provider.springs;
          const m = window.AURA.avatarManager;
          // A huge frame gap must not make the simulation explode.
          for (let i=0;i<5;i++) m.provider.applyPose(m.engine.update(2.0));
          return sp.joints.every(j =>
            Number.isFinite(j.cur.x) && Number.isFinite(j.cur.y) && Number.isFinite(j.cur.z)
            && j.cur.length() < 1000);
        }""")
        rec("fixed timestep survives a 2s frame spike (no explosion)", stable)

        toggle = await page.evaluate("""()=>{
          const p = window.AURA.avatarManager.provider;
          const off = p.setSpringBones(false);
          const on = p.setSpringBones(true);
          return {off, on};
        }""")
        rec("spring bones can be toggled", toggle["off"] is False and toggle["on"] is True)

        back = await page.evaluate("""async()=>{
          const r = await window.AURA.avatarManager.use('builtin');
          return r.ok;
        }""")
        rec("switching back to built-in still works", back)

        print("\n\033[36m▸ ERRORS\033[0m")
        real = [e for e in errors if "favicon" not in e.lower()]
        rec("no page errors", not real, "; ".join(real)[:170])

        await b.close()

    print(f"\n  \033[32mPASS {pass_n}\033[0m  " + (f"\033[31mFAIL {fail_n}\033[0m" if fail_n else "FAIL 0"))
    sys.exit(1 if fail_n else 0)


asyncio.run(main())
