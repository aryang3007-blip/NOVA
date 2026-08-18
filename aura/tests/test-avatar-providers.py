#!/usr/bin/env python3
"""
AURA :: Avatar Provider architecture — browser tests

Proves the thing that actually matters about this design: the animation
system is independent of the renderer, so EVERY provider inherits lip-sync,
blinking, emotions and — the original complaint — waving back.

Also builds a real GLB in-browser and imports it, so the VRM/GLB path is
tested against actual binary glTF rather than a mock.
"""
import asyncio
import sys
from playwright.async_api import async_playwright

PORT = sys.argv[1] if len(sys.argv) > 1 else "8976"
pass_n = fail_n = 0


def rec(name, cond, detail=""):
    global pass_n, fail_n
    if cond:
        pass_n += 1
        print(f"  \033[32m✓\033[0m {name}" + (f"  \033[90m{detail}\033[0m" if detail else ""))
    else:
        fail_n += 1
        print(f"  \033[31m✗\033[0m {name}  \033[90m{detail}\033[0m")


# A minimal but REAL rigged GLB, built in the browser with three.js and
# exported as binary glTF. Gives us a genuine skinned model to import.
BUILD_GLB = """
async () => {
  const THREE = await import('/vendor/three.module.js');
  // Skeleton: hips -> spine -> rightArm, using VRM-ish names.
  const hips = new THREE.Bone(); hips.name = 'J_Bip_C_Hips';
  const spine = new THREE.Bone(); spine.name = 'J_Bip_C_Spine'; spine.position.y = .3;
  const head = new THREE.Bone(); head.name = 'J_Bip_C_Head'; head.position.y = .6;
  const armR = new THREE.Bone(); armR.name = 'J_Bip_R_UpperArm'; armR.position.set(-.2,.5,0);
  const foreR = new THREE.Bone(); foreR.name = 'J_Bip_R_LowerArm'; foreR.position.y = -.25;
  const handR = new THREE.Bone(); handR.name = 'J_Bip_R_Hand'; handR.position.y = -.25;
  armR.add(foreR); foreR.add(handR);
  spine.add(head); spine.add(armR); hips.add(spine);

  const geo = new THREE.BoxGeometry(.4, 1.6, .2);
  const skinIndex = [], skinWeight = [];
  for (let i = 0; i < geo.attributes.position.count; i++) { skinIndex.push(0,0,0,0); skinWeight.push(1,0,0,0); }
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeight, 4));
  // Two morph targets named like ARKit blendshapes so morph mapping is
  // exercised. The exporter requires geo.morphAttributes.normal to be absent
  // or complete, and a matching morphTargetInfluences length on the mesh.
  const base = geo.attributes.position.array;
  const mk = (scale) => {
    const a = new Float32Array(base.length);
    for (let i = 0; i < base.length; i++) a[i] = base[i] * scale;
    return new THREE.Float32BufferAttribute(a, 3);
  };
  const mA = mk(1.05); mA.name = 'mouthOpen';
  const mB = mk(0.98); mB.name = 'eyeBlinkLeft';
  geo.morphAttributes.position = [mA, mB];
  geo.morphTargetsRelative = false;

  const mesh = new THREE.SkinnedMesh(geo, new THREE.MeshStandardMaterial({ color: 0x88aaff }));
  mesh.morphTargetDictionary = { mouthOpen: 0, eyeBlinkLeft: 1 };
  mesh.morphTargetInfluences = [0, 0];
  const skeleton = new THREE.Skeleton([hips, spine, head, armR, foreR, handR]);
  mesh.add(hips); mesh.bind(skeleton);

  const scene = new THREE.Scene(); scene.add(mesh);
  const { GLTFExporter } = await import('/vendor/loaders/GLTFExporter.js');
  const buf = await new Promise((res, rej) =>
    new GLTFExporter().parse(scene, res, rej, { binary: true }));
  window.__glb = new Blob([buf], { type: 'model/gltf-binary' });
  return { bytes: buf.byteLength };
}
"""


async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch(args=["--no-sandbox", "--enable-unsafe-swiftshader"])
        page = await (await b.new_context()).new_page()
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

        print("\n\033[36m▸ PROVIDER ARCHITECTURE\033[0m")
        info = await page.evaluate("""async()=>{
          const {listProviders, probeProviders, DEFAULT_PROVIDER} = await import('/js/avatar/providers/index.js');
          return {list: listProviders(), probe: await probeProviders(), def: DEFAULT_PROVIDER};
        }""")
        ids = [p["id"] for p in info["list"]]
        # v0.22: the Sphere joined as the DEFAULT (it is the product identity
        # and reflects real agent state). The humanoid is still registered and
        # still selectable — assert by membership, not by a frozen list, so
        # adding a provider is not a test failure.
        rec("four providers registered",
            ids == ["sphere", "builtin", "gltf", "readyplayerme"], str(ids))
        rec("the sphere is the default", info["def"] == "sphere", str(info["def"]))
        rec("the humanoid is still registered", "builtin" in ids, str(ids))
        by_id = {p["id"]: p for p in info["list"]}
        rec("the sphere is offline-capable",
            by_id["sphere"]["capabilities"]["offline"] is True)
        rec("built-in is offline-capable",
            by_id["builtin"]["capabilities"]["offline"] is True)
        rec("Ready Player Me declares it needs internet",
            by_id["readyplayerme"]["capabilities"]["offline"] is False)
        rec("built-in is available here",
            next(p for p in info["probe"] if p["id"] == "builtin")["available"])

        print("\n\033[36m▸ ENGINE IS INDEPENDENT OF THE RENDERER\033[0m")
        eng = await page.evaluate("""async()=>{
          const {AnimationEngine} = await import('/js/avatar/animation-engine.js');
          const e = new AnimationEngine({autoWire:false});
          const out = {};
          e.reactToGesture('wave');
          out.waveImpulse = e.impulse.wave;
          out.waveEmotion = e.emotionName;
          let maxBlink = 0, maxMouth = 0;
          e.pushVisemes([{viseme:'AI', t:0, dur:120, open:0.85}]);
          e.speaking = true;
          for (let i=0;i<600;i++){ const p = e.update(1/60);
            maxBlink = Math.max(maxBlink, p.blink);
            maxMouth = Math.max(maxMouth, p.mouthOpen); }
          out.maxBlink = maxBlink; out.maxMouth = maxMouth;
          out.waveDecayed = e.impulse.wave;
          return out;
        }""")
        rec("wave sets an impulse", eng["waveImpulse"] == 1)
        rec("wave also sets a happy emotion", eng["waveEmotion"] == "happy")
        rec("blink reaches full closure", eng["maxBlink"] >= 0.99, str(eng["maxBlink"]))
        rec("lip-sync opens the mouth", eng["maxMouth"] > 0.8, str(round(eng["maxMouth"], 2)))
        rec("impulses decay", eng["waveDecayed"] == 0)

        print("\n\033[36m▸ DEFAULT PROVIDER (sphere), THEN THE HUMANOID\033[0m")
        st = await page.evaluate("()=>window.AURA.avatarManager.status()")
        rec("the sphere is active by default", st["active"] == "sphere", str(st["active"]))
        rec("no provider error", not st["error"], str(st["error"]))
        # The rest of this suite exercises the humanoid rig (outfits, bones,
        # hair), so switch to it explicitly rather than assuming the default.
        await page.evaluate("async()=>{ await window.AURA.avatarManager.use('builtin'); }")
        await page.wait_for_timeout(1200)
        st = await page.evaluate("()=>window.AURA.avatarManager.status()")
        rec("can switch to the humanoid", st["active"] == "builtin", str(st["active"]))
        await page.wait_for_timeout(1500)
        fps = await page.evaluate("()=>window.AURA.avatarManager.fps")
        rec("render loop is running", fps > 0, f"{fps} fps")

        solid = await page.evaluate("""()=>{
          const b = window.AURA.avatarManager.provider.body;
          return {solid: b.solid, wires: (b.wireMeshes||[]).length,
                  wiresVisible: (b.wireMeshes||[]).filter(w=>w.visible).length};
        }""")
        rec("solid mode is on by default", solid["solid"] is True)
        rec("wireframe overlays hidden in solid mode",
            solid["wiresVisible"] == 0, f"{solid['wiresVisible']}/{solid['wires']} visible")

        # The original complaint, end to end through the bus.
        wave = await page.evaluate("""async()=>{
          const {bus, EV} = await import('/js/core/bus.js');
          const m = window.AURA.avatarManager;
          bus.emit(EV.GESTURE, {gesture:'wave', confidence:.95});
          const imp = m.engine.impulse.wave;
          const before = m.provider.body.bones.upperArmR.rotation.x;
          for (let i=0;i<8;i++) m.provider.applyPose(m.engine.update(1/60));
          return {imp, before, after: m.provider.body.bones.upperArmR.rotation.x};
        }""")
        rec("EV.GESTURE wave reaches the engine", wave["imp"] > 0.9, str(wave["imp"]))
        rec("built-in avatar physically waves back",
            abs(wave["after"] - wave["before"]) > 0.05,
            f"arm {wave['before']:.3f} -> {wave['after']:.3f}")

        print("\n\033[36m▸ VRM / GLB IMPORT (real binary glTF)\033[0m")
        built = await page.evaluate(BUILD_GLB)
        rec("built a real GLB in-browser", built["bytes"] > 500, f"{built['bytes']} bytes")

        imported = await page.evaluate("""async()=>{
          const f = new File([window.__glb], 'test-avatar.glb', {type:'model/gltf-binary'});
          const r = await window.AURA.avatarManager.importModel(f);
          const st = await window.AURA.avatarManager.status();
          const p = window.AURA.avatarManager.provider;
          return {ok:r.ok, reason:r.reason, active:st.active,
                  bones:p.boneCount, morphs:p.morphCount};
        }""")
        rec("GLB imports successfully", imported["ok"], str(imported.get("reason")))
        rec("switched to the gltf provider", imported["active"] == "gltf")
        rec("skeleton bones were mapped", imported["bones"] >= 4, f"{imported['bones']} bones")
        rec("morph targets were found", imported["morphs"] >= 1, f"{imported['morphs']} meshes")

        # Same performance, different renderer.
        gwave = await page.evaluate("""async()=>{
          const {bus, EV} = await import('/js/core/bus.js');
          const m = window.AURA.avatarManager;
          bus.emit(EV.GESTURE, {gesture:'wave', confidence:.95});
          const arm = m.provider.bones.upperArmR;
          const before = arm.rotation.z;
          for (let i=0;i<8;i++) m.provider.applyPose(m.engine.update(1/60));
          return {before, after: arm.rotation.z, imp: m.engine.impulse.wave};
        }""")
        rec("IMPORTED avatar also waves back",
            abs(gwave["after"] - gwave["before"]) > 0.02,
            f"arm {gwave['before']:.3f} -> {gwave['after']:.3f}")

        morphed = await page.evaluate("""()=>{
          const m = window.AURA.avatarManager;
          m.engine.speaking = true;
          m.engine.pushVisemes([{viseme:'AI', t:0, dur:200, open:0.9}]);
          let peak = 0;
          for (let i=0;i<40;i++){ m.provider.applyPose(m.engine.update(1/60));
            const mm = m.provider.morphMeshes[0];
            if (mm) peak = Math.max(peak, mm.mesh.morphTargetInfluences[mm.dict.mouthOpen] || 0); }
          return peak;
        }""")
        rec("lip-sync drives imported morph targets", morphed > 0.5, f"peak {morphed:.2f}")

        print("\n\033[36m▸ READY PLAYER ME URL HANDLING\033[0m")
        rpm = await page.evaluate("""async()=>{
          const {normaliseRpmUrl} = await import('/js/avatar/providers/readyplayerme.js');
          const id='64bfa15f0e72c63d7c3934a6';
          return {
            bare: normaliseRpmUrl(id),
            full: normaliseRpmUrl(`https://models.readyplayer.me/${id}.glb`),
            noext: normaliseRpmUrl(`https://models.readyplayer.me/${id}`),
            query: normaliseRpmUrl(`https://demo.readyplayer.me/avatar?id=${id}`),
            evil: normaliseRpmUrl('https://evil.com/x.glb'),
            js: normaliseRpmUrl('javascript:alert(1)'),
            empty: normaliseRpmUrl(''),
          };
        }""")
        want = "https://models.readyplayer.me/64bfa15f0e72c63d7c3934a6.glb"
        rec("bare ID resolves", rpm["bare"]["ok"] and rpm["bare"]["url"] == want)
        rec("full URL resolves", rpm["full"]["ok"] and rpm["full"]["url"] == want)
        rec("URL without .glb resolves", rpm["noext"]["ok"] and rpm["noext"]["url"] == want)
        rec("?id= form resolves", rpm["query"]["ok"] and rpm["query"]["url"] == want)
        rec("foreign host rejected", not rpm["evil"]["ok"], str(rpm["evil"].get("reason")))
        rec("javascript: rejected", not rpm["js"]["ok"])
        rec("empty input rejected", not rpm["empty"]["ok"])

        print("\n\033[36m▸ SWITCH BACK + AVATAR MANAGER UI\033[0m")
        back = await page.evaluate("""async()=>{
          const r = await window.AURA.avatarManager.use('builtin');
          const st = await window.AURA.avatarManager.status();
          return {ok:r.ok, active:st.active, canvases:document.querySelectorAll('#avatar-host canvas').length};
        }""")
        rec("switches back to built-in", back["ok"] and back["active"] == "builtin")
        rec("old renderer disposed (one canvas)", back["canvases"] == 1, f"{back['canvases']} canvases")

        await page.evaluate("()=>window.AURA.openSettings()")
        await page.wait_for_timeout(400)
        await page.click('.tab[data-tab="avatar"]')
        await page.wait_for_timeout(1200)
        ui = await page.evaluate("""()=>({
          cards: document.querySelectorAll('#av-providers .av-provider').length,
          active: document.querySelectorAll('#av-providers .av-provider.active').length,
          hasFile: !!document.getElementById('av-file'),
          hasRpm: !!document.getElementById('av-rpm-url'),
          solidVisible: !document.getElementById('av-customise-section').hidden,
        })""")
        rec("provider cards rendered", ui["cards"] == 4, f"{ui['cards']} cards")
        rec("active provider highlighted", ui["active"] == 1)
        rec("import control present", ui["hasFile"])
        rec("Ready Player Me field present", ui["hasRpm"])
        rec("built-in customisation shown for built-in", ui["solidVisible"])

        print("\n\033[36m▸ WARDROBE: BODY / HAIR / COLOUR\033[0m")
        await page.evaluate("()=>window.AURA.closeSettings && window.AURA.closeSettings()")
        await page.wait_for_timeout(300)
        ward = await page.evaluate("""()=>({
          body: document.querySelectorAll('[data-body]').length,
          hair: document.querySelectorAll('[data-hair]').length,
          col:  document.querySelectorAll('[data-haircol]').length,
        })""")
        rec("body presets in the wardrobe", ward["body"] >= 6, f"{ward['body']} presets")
        rec("hairstyles in the wardrobe", ward["hair"] >= 10, f"{ward['hair']} styles")
        rec("hair colours in the wardrobe", ward["col"] >= 10, f"{ward['col']} colours")

        hair = await page.evaluate("""()=>{
          const a = window.AURA.avatar, b = window.AURA.avatarManager.provider.body;
          const out = {};
          a.applyHair('none', 'black');   out.none = (b.hairMeshes||[]).length;
          a.applyHair('afro', 'pink');    out.afro = (b.hairMeshes||[]).length;
          a.applyHair('ponytail','blonde'); out.pony = (b.hairMeshes||[]).length;
          a.applyHair('long','silver');   out.long = (b.hairMeshes||[]).length;
          out.color = b.hairColor; out.style = b.hair;
          return out;
        }""")
        rec("'none' builds no hair meshes", hair["none"] == 0)
        rec("afro builds geometry", hair["afro"] >= 1, f"{hair['afro']} meshes")
        rec("ponytail builds geometry", hair["pony"] >= 2, f"{hair['pony']} meshes")
        rec("long hair builds geometry", hair["long"] >= 3, f"{hair['long']} meshes")
        rec("hair state persists", hair["style"] == "long" and hair["color"] == "silver")

        bodyt = await page.evaluate("""()=>{
          const a = window.AURA.avatar, b = window.AURA.avatarManager.provider.body;
          const read = () => ({chest:+b.bones.chest.scale.x.toFixed(3),
                               hips:+b.bones.hips.scale.x.toFixed(3),
                               sh:+b.bones.shoulderL.scale.x.toFixed(3)});
          a.applyBodyType('feminine');  const f = read();
          a.applyBodyType('masculine'); const m = read();
          a.applyBodyType('neutral');   const n = read();
          return {f, m, n};
        }""")
        rec("feminine widens hips vs masculine",
            bodyt["f"]["hips"] > bodyt["m"]["hips"],
            f"F hips {bodyt['f']['hips']} vs M {bodyt['m']['hips']}")
        rec("masculine widens shoulders vs feminine",
            bodyt["m"]["sh"] > bodyt["f"]["sh"],
            f"M {bodyt['m']['sh']} vs F {bodyt['f']['sh']}")
        rec("neutral resets to 1.0", bodyt["n"]["chest"] == 1.0 and bodyt["n"]["hips"] == 1.0)

        # The whole point of scaling bones: animation must still work.
        still = await page.evaluate("""async()=>{
          const {bus, EV} = await import('/js/core/bus.js');
          const m = window.AURA.avatarManager;
          m.provider.applyOutfit('armor','emerald');
          m.provider.applyHair('mohawk','green');
          m.provider.applyBodyType('athletic');
          bus.emit(EV.GESTURE, {gesture:'wave', confidence:.95});
          const arm = m.provider.body.bones.upperArmR;
          const before = arm.rotation.x;
          for (let i=0;i<8;i++) m.provider.applyPose(m.engine.update(1/60));
          return {before, after: arm.rotation.x};
        }""")
        rec("avatar STILL waves after full customisation",
            abs(still["after"] - still["before"]) > 0.05,
            f"arm {still['before']:.3f} -> {still['after']:.3f}")

        print("\n\033[36m▸ ERRORS\033[0m")
        real = [e for e in errors if "favicon" not in e.lower()]
        rec("no page errors", not real, "; ".join(real)[:160])

        await b.close()

    print(f"\n  \033[32mPASS {pass_n}\033[0m  " + (f"\033[31mFAIL {fail_n}\033[0m" if fail_n else "FAIL 0"))
    sys.exit(1 if fail_n else 0)


asyncio.run(main())
