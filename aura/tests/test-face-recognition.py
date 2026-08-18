#!/usr/bin/env python3
"""
AURA :: face recognition (identity) + the new Settings panes

Face *detection* and *expression* already worked; recognising WHO someone is
did not. This verifies the identity layer end-to-end in a real browser.

The signatures are derived from the 478 MediaPipe face landmarks AURA already
computes — no extra model download, fully offline, and no image is ever
stored. Tests feed anatomically plausible synthetic landmark sets so the
result is deterministic; the real camera path uses the same code.
"""
import asyncio
import sys
from playwright.async_api import async_playwright

PORT = sys.argv[1] if len(sys.argv) > 1 else "9401"
pass_n = fail_n = 0


def rec(name, cond, detail=""):
    global pass_n, fail_n
    if cond:
        pass_n += 1
        print(f"  \033[32m✓\033[0m {name}" + (f"  \033[90m{detail}\033[0m" if detail else ""))
    else:
        fail_n += 1
        print(f"  \033[31m✗\033[0m {name}  \033[90m{detail}\033[0m")


# Build face landmark sets with realistic anatomy: nose centred between the
# cheeks (so frontalScore passes) and per-person variation in bone structure.
FACE_HELPER = """
window.__mkFace = (p, opt) => {
  opt = opt || {};
  const scale = opt.scale || 1, dx = opt.dx || 0, noise = opt.noise === undefined ? 0.001 : opt.noise;
  const lm = new Array(478);
  const set = (i,x,y,z) => lm[i] = {
    x: x*scale + dx + (Math.random()-0.5)*noise,
    y: y*scale + (Math.random()-0.5)*noise,
    z: (z||0)*scale };
  const cx=0.5, w=p.width, h=p.height, eye=p.eyeSpan, mo=p.mouthW;
  for (let i=0;i<478;i++) set(i, cx, 0.5, 0);
  set(33,cx-eye,0.42); set(263,cx+eye,0.42);
  set(133,cx-eye*0.42,0.42); set(362,cx+eye*0.42,0.42);
  set(1,cx,0.52,0.02); set(152,cx,0.5+h);
  set(10,cx,0.5-h*0.75); set(234,cx-w,0.5); set(454,cx+w,0.5);
  set(61,cx-mo,0.5+h*0.55); set(291,cx+mo,0.5+h*0.55);
  set(0,cx,0.5+h*0.48); set(17,cx,0.5+h*0.62);
  set(70,cx-eye*1.1,0.5-h*0.28); set(300,cx+eye*1.1,0.5-h*0.28);
  set(55,cx-eye*0.35,0.5-h*0.25); set(285,cx+eye*0.35,0.5-h*0.25);
  set(168,cx,0.5-h*0.1); set(98,cx-p.nostril,0.5+h*0.3); set(327,cx+p.nostril,0.5+h*0.3);
  set(132,cx-w*0.92,0.5+h*0.35); set(361,cx+w*0.92,0.5+h*0.35);
  set(58,cx-w*0.7,0.5+h*0.6); set(288,cx+w*0.7,0.5+h*0.6);
  set(93,cx-w*0.98,0.46); set(323,cx+w*0.98,0.46);
  set(175,cx,0.5+h*0.92); set(46,cx-eye*1.2,0.5-h*0.3); set(276,cx+eye*1.2,0.5-h*0.3);
  set(7,cx-eye*0.8,0.45); set(249,cx+eye*0.8,0.45);
  set(159,cx-eye*0.6,0.40); set(145,cx-eye*0.6,0.445);
  set(386,cx+eye*0.6,0.40); set(374,cx+eye*0.6,0.445);
  set(78,cx-mo*0.8,0.5+h*0.55); set(308,cx+mo*0.8,0.5+h*0.55);
  set(13,cx,0.5+h*0.53); set(14,cx,0.5+h*0.57);
  return lm;
};
window.__people = {
  aryan: {width:0.16, height:0.20, eyeSpan:0.075, mouthW:0.045, nostril:0.022},
  sam:   {width:0.13, height:0.24, eyeSpan:0.062, mouthW:0.055, nostril:0.017},
  alex:  {width:0.185,height:0.17, eyeSpan:0.088, mouthW:0.038, nostril:0.028},
};
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
        await page.wait_for_function("()=>window.AURA && window.AURA.vision", timeout=30000)
        await page.wait_for_timeout(2000)
        await page.evaluate(FACE_HELPER)

        print("\n\033[36m▸ SIGNATURE MATHS\033[0m")
        sig = await page.evaluate("""async()=>{
          const m = await import('/js/vision/face-recognition.js');
          const A1 = m.computeSignature(window.__mkFace(window.__people.aryan));
          const A2 = m.computeSignature(window.__mkFace(window.__people.aryan));
          const B  = m.computeSignature(window.__mkFace(window.__people.sam));
          const far = m.computeSignature(window.__mkFace(window.__people.aryan,{scale:0.55,dx:0.18}));
          return {
            len: A1.length,
            same: m.similarity(A1, A2),
            diff: m.similarity(A1, B),
            moved: m.similarity(A1, far),
            frontal: m.frontalScore(window.__mkFace(window.__people.aryan)),
          };
        }""")
        rec("signature is compact", 15 <= sig["len"] <= 40, f"{sig['len']} features")
        rec("same person scores high", sig["same"] > 0.80, f"{sig['same']:.3f}")
        rec("different people score low", sig["diff"] < 0.50, f"{sig['diff']:.3f}")
        rec("clear separation between same and different",
            sig["same"] - sig["diff"] > 0.35, f"gap {sig['same'] - sig['diff']:.3f}")
        rec("scale/position invariant (moving nearer still matches)",
            sig["moved"] > 0.80, f"{sig['moved']:.3f}")
        rec("frontal pose detected", sig["frontal"] > 0.9, f"{sig['frontal']:.3f}")

        print("\n\033[36m▸ ENROLMENT + IDENTIFICATION\033[0m")
        ident = await page.evaluate("""async()=>{
          const fr = await window.AURA.vision.recognizer();
          fr.forgetAll();
          const out = {};
          for (const name of ['Aryan','Sam']) {
            fr.startEnrollment(name);
            let n = 0, guard = 0;
            while (n < 4 && guard++ < 40) {
              if (fr.addSample(window.__mkFace(window.__people[name.toLowerCase()])).ok) n++;
            }
            out['enrol' + name] = fr.finishEnrollment().ok;
          }
          const id = (p, o) => fr.identify(window.__mkFace(window.__people[p], o));
          out.aryan   = id('aryan');
          out.sam     = id('sam');
          out.unknown = id('alex');
          out.moved   = id('aryan', {scale:0.6, dx:0.14});
          out.count   = fr.list().length;
          return out;
        }""")
        rec("enrolment succeeds", ident["enrolAryan"] and ident["enrolSam"])
        rec("two people stored", ident["count"] == 2)
        rec("recognises Aryan", ident["aryan"]["name"] == "Aryan",
            f"conf {ident['aryan']['confidence']}")
        rec("recognises Sam", ident["sam"]["name"] == "Sam",
            f"conf {ident['sam']['confidence']}")
        rec("does NOT invent a name for a stranger",
            ident["unknown"]["name"] is None,
            f"looked most like {ident['unknown'].get('candidate')} at {ident['unknown']['confidence']}")
        rec("still recognises when nearer/further",
            ident["moved"]["name"] == "Aryan", f"conf {ident['moved']['confidence']}")

        print("\n\033[36m▸ DEBOUNCE (no greeting on one bad frame)\033[0m")
        deb = await page.evaluate("""async()=>{
          const fr = await window.AURA.vision.recognizer();
          const f = () => window.__mkFace(window.__people.aryan);
          fr.resetStability();
          const first = fr.identifyStable(f(), 4);   // frame 1
          let last = first;
          for (let i=0;i<5;i++) last = fr.identifyStable(f(), 4);
          return {firstStable: first.stable, laterStable: last.stable, frames: last.frames};
        }""")
        rec("one frame is not enough to fire", deb["firstStable"] is False)
        rec("several agreeing frames do fire", deb["laterStable"] is True, f"{deb['frames']} frames")

        print("\n\033[36m▸ PRIVACY + PERSISTENCE\033[0m")
        priv = await page.evaluate("""async()=>{
          const fr = await window.AURA.vision.recognizer();
          const raw = localStorage.getItem('aura.faces.v1') || '';
          const parsed = JSON.parse(raw);
          return {
            storesImages: fr.stats().storesImages,
            hasImageData: /data:image|base64|jpeg|png/i.test(raw),
            templateIsNumbers: Array.isArray(parsed.people[0].template)
              && typeof parsed.people[0].template[0] === 'number',
            bytes: raw.length,
            names: parsed.people.map(p => p.name),
          };
        }""")
        rec("declares it stores no images", priv["storesImages"] is False)
        rec("no image data in storage — verified", priv["hasImageData"] is False)
        rec("template is plain numbers", priv["templateIsNumbers"])
        rec("storage is tiny", priv["bytes"] < 12000, f"{priv['bytes']} bytes for 2 people")

        reload_ok = await page.evaluate("""async()=>{
          const { FaceRecognizer } = await import('/js/vision/face-recognition.js');
          const fresh = new FaceRecognizer();
          return fresh.list().map(p => p.name);
        }""")
        rec("survives a reload", sorted(reload_ok) == ["Aryan", "Sam"], str(reload_ok))

        print("\n\033[36m▸ MANAGEMENT\033[0m")
        mgmt = await page.evaluate("""async()=>{
          const fr = await window.AURA.vision.recognizer();
          const id = fr.list()[0].id;
          const renamed = fr.rename(id, 'Renamed Person');
          const nameNow = fr.list().find(p => p.id === id).name;
          const forgot = fr.forget(id);
          const after = fr.list().length;
          fr.forgetAll();
          return {renamed, nameNow, forgot, after, empty: fr.list().length};
        }""")
        rec("rename works", mgmt["renamed"] and mgmt["nameNow"] == "Renamed Person")
        rec("forget one works", mgmt["forgot"] and mgmt["after"] == 1)
        rec("forget all works", mgmt["empty"] == 0)

        print("\n\033[36m▸ SETTINGS UI\033[0m")
        await page.evaluate("()=>window.AURA.openSettings()")
        await page.wait_for_timeout(400)
        await page.click('.tab[data-tab="vision"]')
        await page.wait_for_timeout(700)
        vui = await page.evaluate("""()=>({
          toggle: !!document.getElementById('set-facerec'),
          nameField: !!document.getElementById('face-name'),
          enrolBtn: !!document.getElementById('face-enrol'),
          greet: !!document.getElementById('set-facegreet'),
          list: !!document.getElementById('face-list'),
          privacyNote: (document.getElementById('face-privacy-note')||{}).textContent
                        ?.includes('never an image') || false,
        })""")
        rec("face recognition toggle present", vui["toggle"])
        rec("enrolment controls present", vui["nameField"] and vui["enrolBtn"])
        rec("greeting toggle present", vui["greet"])
        rec("privacy is stated in the UI", vui["privacyNote"])

        noCam = await page.evaluate("""async()=>{
          document.getElementById('face-name').value = 'Test';
          document.getElementById('face-enrol').click();
          await new Promise(r=>setTimeout(r,400));
          return document.getElementById('face-status').textContent;
        }""")
        rec("enrolling without a camera explains itself",
            "camera" in noCam.lower(), noCam[:60])

        await page.click('.tab[data-tab="desktop"]')
        await page.wait_for_timeout(900)
        dui = await page.evaluate("""()=>({
          webToggle: !!document.getElementById('set-websearch'),
          webDepth: !!document.getElementById('set-webdepth'),
          webTest: !!document.getElementById('web-test'),
          autoArm: !!document.getElementById('auto-arm'),
          failsafe: (document.getElementById('auto-failsafe')||{}).textContent || '',
          badge: (document.getElementById('auto-badge')||{}).textContent || '',
        })""")
        rec("web research controls present",
            dui["webToggle"] and dui["webDepth"] and dui["webTest"])
        rec("automation arm button present", dui["autoArm"])
        rec("kill switch is explained in the UI", "top-left" in dui["failsafe"].lower())
        rec("automation state is shown", dui["badge"] != "")

        print("\n\033[36m▸ ERRORS\033[0m")
        real = [e for e in errors if "favicon" not in e.lower()]
        rec("no page errors", not real, "; ".join(real)[:170])

        await b.close()

    print(f"\n  \033[32mPASS {pass_n}\033[0m  " + (f"\033[31mFAIL {fail_n}\033[0m" if fail_n else "FAIL 0"))
    sys.exit(1 if fail_n else 0)


asyncio.run(main())
