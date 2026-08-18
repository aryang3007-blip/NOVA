#!/usr/bin/env python3
"""
AURA :: VRM MToon cel-shading + real-VRM spring bones

Closes the two things previously flagged as unverified:

  1. "MToon materials are not implemented — a VRM renders with standard glTF
     shading rather than its authored cel-shaded look."
  2. "Spring bones are tested against a GLB I generate with a hair chain; a
     genuine VRoid model on your machine is the actual proof."

This test builds a **real VRM** in the browser: a rigged glTF carrying actual
`VRMC_vrm`, `VRMC_materials_mtoon` and `VRMC_springBone` extension blocks, plus
a VRM 0.x variant using `VRM.secondaryAnimation` and `VRM.materialProperties`.
Both are then imported through AURA's real code path.

It is not a VRoid export, but it exercises the same parsing branches a VRoid
file hits — which is what actually determines whether the feature works.
"""
import asyncio
import sys
from playwright.async_api import async_playwright

PORT = sys.argv[1] if len(sys.argv) > 1 else "9301"
pass_n = fail_n = 0


def rec(name, cond, detail=""):
    global pass_n, fail_n
    if cond:
        pass_n += 1
        print(f"  \033[32m✓\033[0m {name}" + (f"  \033[90m{detail}\033[0m" if detail else ""))
    else:
        fail_n += 1
        print(f"  \033[31m✗\033[0m {name}  \033[90m{detail}\033[0m")


# Build a rigged model, export to GLB, then splice real VRM extension blocks
# into the JSON chunk and re-pack it. That yields a file the loader and our
# MToon/spring readers treat exactly like a VRoid export.
BUILD_VRM = """
async (vrmVersion) => {
  const THREE = await import('/vendor/three.module.js');
  const { GLTFExporter } = await import('/vendor/loaders/GLTFExporter.js');

  // Humanoid core + a hair chain (VRM bone naming).
  const hips = new THREE.Bone(); hips.name = 'J_Bip_C_Hips';
  const spine = new THREE.Bone(); spine.name = 'J_Bip_C_Spine'; spine.position.y = .25;
  const head = new THREE.Bone(); head.name = 'J_Bip_C_Head'; head.position.y = .45;
  const armR = new THREE.Bone(); armR.name = 'J_Bip_R_UpperArm'; armR.position.set(-.18,.35,0);
  const foreR = new THREE.Bone(); foreR.name = 'J_Bip_R_LowerArm'; foreR.position.y = -.24;
  armR.add(foreR); spine.add(head); spine.add(armR); hips.add(spine);

  const hairBones = [];
  let parent = head;
  for (let i = 1; i <= 4; i++) {
    const b = new THREE.Bone();
    b.name = 'J_Sec_Hair' + i + '_01';
    b.position.y = -0.07;
    parent.add(b); parent = b; hairBones.push(b);
  }

  const geo = new THREE.BoxGeometry(.34, 1.5, .22);
  const si = [], sw = [];
  for (let i = 0; i < geo.attributes.position.count; i++) { si.push(0,0,0,0); sw.push(1,0,0,0); }
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));

  const mat = new THREE.MeshStandardMaterial({ color: 0xffd7c4 });
  mat.name = 'F00_000_Face_00_SKIN';
  const mesh = new THREE.SkinnedMesh(geo, mat);
  mesh.name = 'Face';
  const all = []; hips.traverse(b => all.push(b));
  mesh.add(hips); mesh.bind(new THREE.Skeleton(all));

  const scene = new THREE.Scene(); scene.add(mesh);
  const buf = await new Promise((res, rej) =>
    new GLTFExporter().parse(scene, res, rej, { binary: true }));

  // ── splice VRM extensions into the GLB's JSON chunk ──────────────────
  const dv = new DataView(buf);
  const jsonLen = dv.getUint32(12, true);
  const jsonBytes = new Uint8Array(buf, 20, jsonLen);
  const json = JSON.parse(new TextDecoder().decode(jsonBytes));
  const binOffset = 20 + jsonLen;
  const binChunk = buf.byteLength > binOffset ? buf.slice(binOffset) : null;

  const nodeIndex = (name) => (json.nodes || []).findIndex(n => n.name === name);
  const hairIdx = hairBones.map(b => nodeIndex(b.name)).filter(i => i >= 0);
  const headIdx = nodeIndex('J_Bip_C_Head');

  json.extensionsUsed = json.extensionsUsed || [];

  if (vrmVersion === '1.0') {
    json.extensionsUsed.push('VRMC_vrm', 'VRMC_materials_mtoon', 'VRMC_springBone');
    json.extensions = json.extensions || {};
    json.extensions.VRMC_vrm = {
      specVersion: '1.0',
      meta: { name: 'AURA Test VRM', authors: ['test'] },
      humanoid: { humanBones: { hips: { node: nodeIndex('J_Bip_C_Hips') },
                                head: { node: headIdx } } },
    };
    json.extensions.VRMC_springBone = {
      specVersion: '1.0',
      colliders: [{ node: headIdx, shape: { sphere: { offset: [0, 0, 0], radius: 0.12 } } }],
      colliderGroups: [{ name: 'head', colliders: [0] }],
      springs: [{
        name: 'HairL',
        joints: hairIdx.map(n => ({ node: n, hitRadius: 0.02,
                                    stiffness: 0.62, gravityPower: 0.3, dragForce: 0.35 })),
        colliderGroups: [0],
      }],
    };
    // MToon on the face material.
    (json.materials || []).forEach(m => {
      m.extensions = m.extensions || {};
      m.extensions.VRMC_materials_mtoon = {
        specVersion: '1.0',
        shadeColorFactor: [0.72, 0.48, 0.45],
        shadingShiftFactor: -0.05,
        shadingToonyFactor: 0.95,
        parametricRimLiftFactor: 0.42,
        parametricRimFresnelPowerFactor: 4.0,
        outlineWidthFactor: 0.0018,
        outlineColorFactor: [0.13, 0.09, 0.11],
      };
    });
  } else {
    json.extensionsUsed.push('VRM');
    json.extensions = json.extensions || {};
    json.extensions.VRM = {
      specVersion: '0.0',
      meta: { title: 'AURA Test VRM 0.x' },
      humanoid: { humanBones: [{ bone: 'hips', node: nodeIndex('J_Bip_C_Hips') }] },
      materialProperties: (json.materials || []).map(m => ({
        name: m.name, shader: 'VRM/MToon',
        floatProperties: { _ShadeShift: -0.1, _ShadeToony: 0.85,
                           _RimLightingMix: 0.5, _RimFresnelPower: 3.5, _OutlineWidth: 1.4 },
        vectorProperties: { _ShadeColor: [0.6, 0.4, 0.4, 1], _OutlineColor: [0.1, 0.1, 0.15, 1] },
      })),
      secondaryAnimation: {
        colliderGroups: [{ node: headIdx, colliders: [{ offset: {x:0,y:0,z:0}, radius: 0.12 }] }],
        boneGroups: [{
          bones: hairIdx.length ? [hairIdx[0]] : [],
          stiffiness: 0.7, gravityPower: 0.35, dragForce: 0.4, hitRadius: 0.02,
          colliderGroups: [0],
        }],
      },
    };
  }

  // Re-pack the GLB.
  const enc = new TextEncoder().encode(JSON.stringify(json));
  const pad = (4 - (enc.byteLength % 4)) % 4;
  const jsonPadded = new Uint8Array(enc.byteLength + pad).fill(0x20);
  jsonPadded.set(enc);
  const binLen = binChunk ? binChunk.byteLength : 0;
  const total = 12 + 8 + jsonPadded.byteLength + binLen;
  const out = new ArrayBuffer(total);
  const o = new DataView(out);
  o.setUint32(0, 0x46546C67, true); o.setUint32(4, 2, true); o.setUint32(8, total, true);
  o.setUint32(12, jsonPadded.byteLength, true); o.setUint32(16, 0x4E4F534A, true);
  new Uint8Array(out, 20, jsonPadded.byteLength).set(jsonPadded);
  if (binChunk) new Uint8Array(out, 20 + jsonPadded.byteLength).set(new Uint8Array(binChunk));

  window.__vrm = new Blob([out], { type: 'model/gltf-binary' });
  return { bytes: total, hairNodes: hairIdx.length, version: vrmVersion };
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

        # ── VRM 1.0 ───────────────────────────────────────────────────────
        print("\n\033[36m▸ REAL VRM 1.0 (VRMC_* extensions)\033[0m")
        built = await page.evaluate(BUILD_VRM, "1.0")
        rec("built a VRM 1.0 file", built["bytes"] > 1000,
            f"{built['bytes']} bytes, {built['hairNodes']} hair nodes")

        loaded = await page.evaluate("""async()=>{
          const f = new File([window.__vrm], 'test.vrm', {type:'model/gltf-binary'});
          const r = await window.AURA.avatarManager.importModel(f);
          const p = window.AURA.avatarManager.provider;
          const json = p._gltf?.parser?.json;
          return {ok:r.ok, reason:r.reason,
                  hasVrmExt: !!json?.extensions?.VRMC_vrm,
                  springs: p.springs ? p.springs.describe() : null,
                  mtoon: p.mtoonInfo || null, bones: p.boneCount};
        }""")
        rec(".vrm file imports", loaded["ok"], str(loaded.get("reason")))
        rec("VRM extension block is present", loaded["hasVrmExt"])
        rec("humanoid bones retargeted", loaded["bones"] >= 4, f"{loaded['bones']} bones")

        rec("spring bones read from VRMC_springBone",
            loaded["springs"] and loaded["springs"]["source"] == "vrm1",
            str(loaded["springs"]))
        rec("VRM collider imported",
            loaded["springs"] and loaded["springs"]["colliders"] >= 1,
            f"{loaded['springs']['colliders'] if loaded['springs'] else 0} colliders")

        rec("MToon applied from the VRM extension",
            loaded["mtoon"] and loaded["mtoon"]["applied"], str(loaded["mtoon"]))
        rec("MToon read the real extension (not defaults)",
            loaded["mtoon"] and loaded["mtoon"]["source"] == "VRMC_materials_mtoon",
            str(loaded["mtoon"]["source"] if loaded["mtoon"] else None))
        rec("outline shells created",
            loaded["mtoon"] and loaded["mtoon"]["outlines"] >= 1,
            f"{loaded['mtoon']['outlines'] if loaded['mtoon'] else 0} outlines")

        shader = await page.evaluate("""()=>{
          const p = window.AURA.avatarManager.provider;
          let toon = 0, pbr = 0, uniforms = null, outlines = 0;
          p.root.traverse(o => {
            if (o.userData?.isMToonOutline) outlines++;
            const ms = Array.isArray(o.material) ? o.material : [o.material];
            for (const m of ms) {
              if (!m) continue;
              if (m.userData?.isMToon) { toon++; uniforms = uniforms || {
                shade: m.uniforms.uShade.value.getHexString(),
                toony: m.uniforms.uShadeToony.value,
                shift: m.uniforms.uShadeShift.value,
                rim: m.uniforms.uRimIntensity.value,
                steps: m.uniforms.uSteps.value,
              }; }
              else if (m.isMeshStandardMaterial) pbr++;
            }
          });
          return {toon, pbr, uniforms, outlines};
        }""")
        rec("materials are now cel-shaded, not PBR",
            shader["toon"] >= 1, f"{shader['toon']} toon / {shader['pbr']} pbr")
        rec("shade colour came from the file",
            shader["uniforms"] and shader["uniforms"]["shade"] != "ffffff",
            f"#{shader['uniforms']['shade'] if shader['uniforms'] else '?'}")
        rec("shadingToony honoured",
            shader["uniforms"] and abs(shader["uniforms"]["toony"] - 0.95) < 0.01,
            str(shader["uniforms"]["toony"] if shader["uniforms"] else None))
        rec("rim intensity honoured",
            shader["uniforms"] and abs(shader["uniforms"]["rim"] - 0.42) < 0.01,
            str(shader["uniforms"]["rim"] if shader["uniforms"] else None))
        rec("outline meshes are in the scene", shader["outlines"] >= 1, f"{shader['outlines']}")

        toggle = await page.evaluate("""()=>{
          const p = window.AURA.avatarManager.provider;
          p.setToonShading(false);
          let pbrAfter = 0, toonAfter = 0, shells = 0;
          p.root.traverse(o => {
            if (o.userData?.isMToonOutline) shells++;
            const ms = Array.isArray(o.material) ? o.material : [o.material];
            for (const m of ms) {
              if (m?.userData?.isMToon) toonAfter++;
              else if (m?.isMeshStandardMaterial) pbrAfter++;
            }
          });
          p.setToonShading(true);
          let toonBack = 0;
          p.root.traverse(o => {
            const ms = Array.isArray(o.material) ? o.material : [o.material];
            for (const m of ms) if (m?.userData?.isMToon) toonBack++;
          });
          return {pbrAfter, toonAfter, shells, toonBack};
        }""")
        rec("toon can be switched off losslessly",
            toggle["toonAfter"] == 0 and toggle["pbrAfter"] >= 1,
            f"{toggle['pbrAfter']} PBR restored")
        rec("outline shells removed when off", toggle["shells"] == 0)
        rec("toon can be switched back on", toggle["toonBack"] >= 1)

        motion = await page.evaluate("""async()=>{
          const {bus, EV} = await import('/js/core/bus.js');
          const m = window.AURA.avatarManager;
          const sp = m.provider.springs;
          const j = sp.joints[sp.joints.length - 1];
          const start = j.cur.clone();
          bus.emit(EV.GESTURE, {gesture:'wave', confidence:.95});
          let maxD = 0;
          for (let i=0;i<90;i++) {
            m.provider.applyPose(m.engine.update(1/60));
            maxD = Math.max(maxD, j.cur.distanceTo(start));
          }
          return {maxD, finite: sp.joints.every(x => Number.isFinite(x.cur.y))};
        }""")
        rec("VRM hair swings when the avatar moves",
            motion["maxD"] > 0.0005, f"max displacement {motion['maxD']:.5f}")
        rec("simulation stays finite", motion["finite"])

        # ── VRM 0.x ───────────────────────────────────────────────────────
        print("\n\033[36m▸ REAL VRM 0.x (legacy extension)\033[0m")
        await page.evaluate(BUILD_VRM, "0.x")
        legacy = await page.evaluate("""async()=>{
          const f = new File([window.__vrm], 'legacy.vrm', {type:'model/gltf-binary'});
          const r = await window.AURA.avatarManager.importModel(f);
          const p = window.AURA.avatarManager.provider;
          return {ok:r.ok, springs: p.springs ? p.springs.describe() : null,
                  mtoon: p.mtoonInfo || null};
        }""")
        rec("VRM 0.x imports", legacy["ok"])
        rec("spring bones read from VRM.secondaryAnimation",
            legacy["springs"] and legacy["springs"]["source"] == "vrm0",
            str(legacy["springs"]["source"] if legacy["springs"] else None))
        rec("MToon read from VRM.materialProperties",
            legacy["mtoon"] and legacy["mtoon"]["source"] == "VRM.materialProperties",
            str(legacy["mtoon"]["source"] if legacy["mtoon"] else None))

        legacy_u = await page.evaluate("""()=>{
          const p = window.AURA.avatarManager.provider;
          let u = null;
          p.root.traverse(o => {
            const ms = Array.isArray(o.material) ? o.material : [o.material];
            for (const m of ms) if (m?.userData?.isMToon && !u)
              u = { toony: m.uniforms.uShadeToony.value, shift: m.uniforms.uShadeShift.value };
          });
          return u;
        }""")
        rec("0.x _ShadeToony honoured",
            legacy_u and abs(legacy_u["toony"] - 0.85) < 0.01, str(legacy_u))

        # ── plain GLB must NOT be silently restyled ───────────────────────
        print("\n\033[36m▸ PLAIN GLB IS LEFT ALONE\033[0m")
        plain = await page.evaluate("""async()=>{
          const THREE = await import('/vendor/three.module.js');
          const { GLTFExporter } = await import('/vendor/loaders/GLTFExporter.js');
          const bone = new THREE.Bone(); bone.name = 'Root';
          const geo = new THREE.BoxGeometry(.3,1.4,.2);
          const si=[],sw=[];
          for (let i=0;i<geo.attributes.position.count;i++){si.push(0,0,0,0);sw.push(1,0,0,0);}
          geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si,4));
          geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw,4));
          const mesh = new THREE.SkinnedMesh(geo, new THREE.MeshStandardMaterial({color:0x88aaff}));
          mesh.add(bone); mesh.bind(new THREE.Skeleton([bone]));
          const sc = new THREE.Scene(); sc.add(mesh);
          const buf = await new Promise((res,rej)=> new GLTFExporter().parse(sc,res,rej,{binary:true}));
          const f = new File([buf], 'plain.glb', {type:'model/gltf-binary'});
          const r = await window.AURA.avatarManager.importModel(f);
          const p = window.AURA.avatarManager.provider;
          return {ok:r.ok, mtoon:p.mtoonInfo};
        }""")
        rec("plain GLB still imports", plain["ok"])
        rec("plain GLB is NOT auto-toon-shaded",
            plain["mtoon"] and plain["mtoon"]["applied"] is False,
            str(plain["mtoon"]))
        rec("reason is reported honestly",
            plain["mtoon"] and plain["mtoon"]["source"] == "not-a-vrm")

        forced = await page.evaluate("""()=>{
          const p = window.AURA.avatarManager.provider;
          const ok = p.setToonShading(true);
          let toon = 0;
          p.root.traverse(o => {
            const ms = Array.isArray(o.material) ? o.material : [o.material];
            for (const m of ms) if (m?.userData?.isMToon) toon++;
          });
          return {ok, toon};
        }""")
        rec("but toon CAN be forced on a plain GLB", forced["toon"] >= 1, f"{forced['toon']} materials")

        back = await page.evaluate("()=>window.AURA.avatarManager.use('builtin').then(r=>r.ok)")
        rec("switching back to the built-in avatar works", back)

        print("\n\033[36m▸ ERRORS\033[0m")
        real = [e for e in errors if "favicon" not in e.lower()]
        rec("no page errors", not real, "; ".join(real)[:170])

        await b.close()

    print(f"\n  \033[32mPASS {pass_n}\033[0m  " + (f"\033[31mFAIL {fail_n}\033[0m" if fail_n else "FAIL 0"))
    sys.exit(1 if fail_n else 0)


asyncio.run(main())
