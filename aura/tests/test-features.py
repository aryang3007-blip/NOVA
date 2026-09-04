#!/usr/bin/env python3
"""
AURA :: feature subsystem tests
================================
The VARIABLIZE rule in one file: the manifest is one source of truth, the
terminal flag parser, the shared outline rules, image generation (with
injected seams), OOXML motion and the CANONICAL service.generate all agree.

    python3 tests/test-features.py
"""
import base64
import os
import shutil
import sys
import tempfile
import urllib.error

# ── spend-ledger isolation: THIS suite writes its own temp DB ──────────
# (budget/retry tests record usage — never pollute the real AURA DB).
_FEATURES_DB = tempfile.mkdtemp(prefix="aura-features-test-")
os.environ["AURA_DB_PATH"] = os.path.join(_FEATURES_DB, "features.db")

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from services import registry                                 # noqa: E402
from services.docgen import animations, images, outline      # noqa: E402
from services.docgen import service as doc_service           # noqa: E402
from services.docgen import builder as doc_builder           # noqa: E402
from server import serve                                     # noqa: E402

P, F = [], []


def ok(n, c, d=""):
    (P if c else F).append(n)
    print(("  \033[32m✓\033[0m " if c else "  \033[31m✗\033[0m ") + n
          + (f"  \033[90m{d}\033[0m" if d else ""))


def sec(t):
    print(f"\n\033[36m▸ {t}\033[0m")


OUT = os.path.join(os.path.expanduser("~"), "aura-feature-test-out")
shutil.rmtree(OUT, ignore_errors=True)
shutil.rmtree(_FEATURES_DB, ignore_errors=True)  # ledger DB was created above

# ════════════════════════════════════════════════════════════ MANIFEST
sec("ONE MANIFEST, ONE VOCABULARY")
feats = registry.features()
ok("features present: pptx/docx/xlsx/research",
   {"pptx", "docx", "xlsx", "research"} <= set(feats.keys()),
   str(sorted(feats.keys())))
ok("every feature has defaults", all(isinstance(f.get("defaults"), dict) for f in feats.values()))
ok("pptx defaults cover every popup knob",
   {"slides", "theme", "transition", "speed", "animation", "images"} <=
   set(feats["pptx"]["defaults"].keys()))
ok("every manifest theme is a supported builder theme",
   set(registry.themes()) <= set(doc_builder.THEMES.keys()),
   f"manifest={set(registry.themes())} builder={set(doc_builder.THEMES.keys())}")
ok("holiday + neon themes are real builder themes",
   {"holiday", "neon"} <= set(doc_builder.THEMES.keys()))
ok("transitions include the PowerPoint classics",
   {"fade", "push", "wipe", "zoom", "random"} <= set(registry.transitions()))
ok("entrance animations exist (bounce default popup pick)",
   "bounce" in registry.animations())
provs = registry.image_providers()
ok("image providers declare kind+model",
   all(p.get("kind") and p.get("model") for p in provs))
ok("both known providers listed", {p["id"] for p in provs} == {"gemini", "openai"})
ok("canon() resolves one caller shape", registry.canon("pptx")["id"] == "pptx")

# ═══════════════════════════════════════════════════════ CLI OPTION PARSER
sec("/doc FLAGS → CANONICAL OPTIONS (pure parser)")
plain = serve._cli_build_options("pptx", "")
ok("no flags → manifest defaults", plain["transition"] == "fade"
   and plain["animation"] == "none" and plain["speed"] == "med"
   and plain["images"]["enabled"] is False)
o = serve._cli_build_options("pptx",
    "--theme holiday --transition push --speed slow --animation bounce "
    "--images 2 --style '3d render' --provider openai")
ok("theme parses", o["theme"] == "holiday", o["theme"])
ok("transition parses", o["transition"] == "push")
ok("speed parses", o["speed"] == "slow")
ok("animation parses", o["animation"] == "bounce")
ok("images enabled with count", o["images"]["enabled"] and o["images"]["count"] == 2)
ok("quoted style keeps the space", o["images"]["style"] == "3d render", o["images"]["style"])
ok("provider parses", o["images"]["provider"] == "openai")
once = serve._cli_build_options("pptx", "--images")
ok("--images without count → enabled, 1 image", once["images"]["enabled"]
   and once["images"]["count"] == 1)
ok("docx ignores all pptx flags",
   serve._cli_build_options("docx", "--theme neon --images 3")["images"]["enabled"] is False)

# ════════════════════════════════════════════════════════════ OUTLINE
sec("SHARED OUTLINE RULES + VALIDATION")
ok("system prompt carries the shape", "slides" in outline.system_prompt("pptx", 10))
ok("user prompt carries topic + details",
   "Topic: Mars" in outline.user_prompt("Mars", "with timeline"))
ok("bad pptx spec is rejected with the real cause",
   outline.validate("pptx", {"title": "x"})[1] == "The model outline had no slides.")
ok("docx spec validates", outline.validate("docx", {"sections": [{"heading": "A"}]})[0] is not None)
ok("unknown kind is honest", "Unknown document kind" in outline.validate("exe", {})[1])

# ════════════════════════════════════════════════════════════ IMAGES
sec("IMAGE GENERATION — HONEST + WIRE-TESTED")
av = images.availability(key_fn=lambda p: "k" if p == "gemini" else "")
ok("availability reports the key truth per provider",
   {a["id"]: a["hasKey"] for a in av} == {"gemini": True, "openai": False})
no_key = images.generate("cat", provider="openai", key_fn=lambda p: None)
ok("no key → honest message, no fake file",
   not no_key["ok"] and "key" in no_key["message"].lower())

def fake_nano(_req):
    b64 = base64.b64encode(b"\x89PNG\r\n\x1a\nAURA").decode()
    class R:
        def read(self):
            return (b'{"candidates":[{"content":{"parts":[{"inlineData":'
                    b'{"mimeType":"image/png","data":"' + b64.encode() + b'"}}]}}]}')
    return R()

r = images.generate("a rocket", style="flat illustration", provider="gemini",
                    outdir=OUT, key_fn=lambda p: "test-key", urlopen_fn=fake_nano)
ok("gemini Nano Banana flow returns a saved PNG",
   r["ok"] and os.path.isfile(r.get("path", "")))
ok("model reported is the LIVE manifest model (Imagen 3/4 are shut down)",
   r.get("model") == "gemini-3.1-flash-image", str(r.get("model")))
r2 = images.generate("a rocket", provider="gemini", model="gemini-3-pro-image",
                     outdir=OUT, key_fn=lambda p: "test-key", urlopen_fn=fake_nano)
ok("explicit image model override is honoured and reported",
   r2["ok"] and r2["model"] == "gemini-3-pro-image", str(r2))
r3 = images.generate("a rocket", provider="gemini", model="imagen-3.0-generate-002",
                     outdir=OUT, key_fn=lambda p: "test-key", urlopen_fn=fake_nano)
ok("dead/shoddy model id is rejected honestly before any HTTP call",
   not r3["ok"] and "unknown" in r3["message"], str(r3))

def fake_error(_req):
    raise urllib.error.HTTPError("https://x", 401, "Unauthorized",
                                 None, __import__("io").BytesIO(b"bad key"))
r = images.generate("x", provider="gemini", outdir=OUT,
                    key_fn=lambda p: "bad", urlopen_fn=fake_error)
ok("HTTP 401 → honest provider message",
   not r["ok"] and "HTTP 401" in r["message"] and "bad key" in r["message"])

class BadB64:
    def read(self):
        return b'{"candidates":[{"content":{"parts":[{"inlineData":{"data":"@@not-b64@@"}}]}}]}'
r = images.generate("x", provider="gemini", outdir=OUT,
                    key_fn=lambda p: "k", urlopen_fn=lambda _req: BadB64())
ok("bad base64 → honest message", not r["ok"] and "bad base64" in r["message"])

# ── QUOTA / SPEND: the 429 day — budget blocks BEFORE the wire ──
def _quota_state():
    try:
        from persistence.repositories import usage_repo as _ur
        return _ur
    except Exception:
        return None

_ur = _quota_state()
if _ur is not None:
    old_budget = _ur.get_budget()
    # 1) cap hit → blocked BEFORE the wire (the 429-day protection)
    _ur.set_budget({"enabled": True, "requestsPerDay": 0, "imagesPerDay": 1})
    _ur.record("gemini", "gemini-3.1-flash-image", kind="image", status="ok")
    calls2 = []
    def _never2(_req):
        calls2.append(1)
        return None  # would crash if the wire were touched
    rb = images.generate("x", provider="gemini", outdir=OUT,
                          key_fn=lambda p: "k", urlopen_fn=_never2)
    ok("image cap hit → blocked with the honest message, ZERO network calls",
       rb.get("blocked") is True and "daily image budget" in rb["message"]
       and not calls2, str(rb.get("message"))[:70])
    # 2) unlimited for the wire tests
    _ur.set_budget({"enabled": True, "requestsPerDay": 0, "imagesPerDay": 0})
    _SEQ = [429, 200]
    def _flaky(_req):
        code = _SEQ.pop(0)
        if code != 200:
            raise urllib.error.HTTPError("https://x", code, "Quota",
                                         None, __import__("io").BytesIO(
                                             b'{"error":{"message":"You exceeded your current quota, '
                                             b'please check your plan and billing details. For more '
                                             b'information on this error, visit the error codes page '
                                             b'and search for the error code in the message body."}}'))
        b64 = base64.b64encode(b"\x89PNG\r\n\x1a\nAURA").decode()
        class R:
            def read(self):
                return (b'{"candidates":[{"content":{"parts":[{"inlineData":'
                        b'{"mimeType":"image/png","data":"' + b64.encode() + b'"}}]}}]}')
        return R()
    rr = images.generate("x", provider="gemini", outdir=OUT,
                         key_fn=lambda p: "k", urlopen_fn=_flaky,
                         retries=1, retry_delay=0)
    ok("429 → retried once → image generated (quota spikes are transient)",
       rr["ok"] and os.path.isfile(rr.get("path", "")), str(rr.get("message", ""))[:80])
    _SEQ = [429, 429]
    rr2 = images.generate("x", provider="gemini", outdir=OUT,
                          key_fn=lambda p: "k", urlopen_fn=_flaky,
                          retries=1, retry_delay=0)
    ok("429 exhausted → honest SHORT error (no raw JSON dump, no double text)",
       not rr2["ok"] and len(rr2["message"]) < 180 and '"' not in rr2["message"]
       and rr2["message"].count("HTTP 429") == 1, rr2["message"][:120])
    _ur.set_budget(old_budget)
else:
    ok("budget suite skipped (persistence unavailable) — honest", True)

# expand_image_markers with a stubbed generator (no network in tests)
_orig = images.generate
_seen_models = []
def _stub(prompt, style, provider, outdir, model=None):
    _seen_models.append(model)
    return {"ok": True, "path": os.path.join(outdir, "stub.png"),
            "provider": provider, "model": model or "stub", "bytes": 4}
images.generate = _stub
try:
    spec = {"title": "T", "slides": [
        {"kind": "image", "title": "P1", "image": "@gen:3d render"},
        {"kind": "image", "title": "P2", "image": ""},
    ]}
    spec2, embedded, failed = outline.expand_image_markers(
        spec, {"enabled": True, "count": 2, "style": "flat illustration",
               "provider": "gemini", "model": "gemini-3-pro-image"}, "Mars", OUT)
    ok("markers become real image paths", spec2["slides"][0]["image"].endswith("stub.png"))
    ok("auto-visual fills an empty image slide", spec2["slides"][1]["image"].endswith("stub.png"))
    ok("embedded report lists the slides", len(embedded) == 2 and not failed)
    ok("chosen image model reaches the generator (markers + auto)",
       len(_seen_models) == 2 and all(m == "gemini-3-pro-image" for m in _seen_models),
       str(_seen_models))
    spec3, e3, f3 = outline.expand_image_markers(spec, {"enabled": False}, "Mars", OUT)
    ok("images disabled → spec untouched", e3 == [] and spec3["slides"][0]["image"] == "@gen:3d render")

    # ── THE duplicate-429 bug: a FAILED marker must never be asked twice ──
    calls = []
    def _fail_once(prompt, style, provider, outdir, model=None):
        calls.append(model)
        return {"ok": False, "message": "daily image budget reached (1/1)"}
    images.generate = _fail_once
    spec4, e4, f4 = outline.expand_image_markers(
        {"title": "T", "slides": [{"kind": "image", "title": "P1",
                                   "image": "@gen:photorealistic"}]},
        {"enabled": True, "count": 5, "style": "flat illustration",
         "provider": "gemini"}, "Mars", OUT)
    ok("failed marker → ONE API call, no auto-visual retry (the old double-429 log)",
       len(calls) == 1 and len(f4) == 1 and not e4, f"calls={len(calls)}")
finally:
    images.generate = _orig

# ══════════════════════════════════════════════════════ MOTION (OOXML)
sec("TRANSITIONS + ENTRANCE ANIMATIONS — REAL OOXML")
def resolver(path, must_exist=False, **kw):  # noqa: unused kwargs on purpose
    return path, None

import zipfile  # noqa: E402

def _slide(title, tid):
    """Realistic minimal slide: a title (1 paragraph) + a body shape with 3
    bullet paragraphs — what the per-bullet engine actually targets."""
    return (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            f'<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" '
            f'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
            f'<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/></p:nvGrpSpPr>'
            f'<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title {tid}"/></p:nvSpPr>'
            f'<p:txBody><a:bodyPr/><a:p><a:r><a:t>{title}</a:t></a:r></a:p>'
            f'</p:txBody></p:sp>'
            f'<p:sp><p:nvSpPr><p:cNvPr id="3" name="Content Placeholder {tid}"/></p:nvSpPr>'
            f'<p:txBody><a:bodyPr/>'
            f'<a:p><a:r><a:t>{title} one</a:t></a:r></a:p>'
            f'<a:p><a:r><a:t>{title} two</a:t></a:r></a:p>'
            f'<a:p><a:r><a:t>{title} three</a:t></a:r></a:p>'
            f'</p:txBody></p:sp></p:spTree></p:cSld></p:sld>')
_SLIDE1 = _slide("Title One", 1)
_SLIDE2 = _slide("Title Two", 2)


def _fixture_pptx(path):
    """Minimal OOXML deck (no python-pptx needed — motion works on the zip)."""
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml",
                   '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/'
                   'package/2006/content-types"><Default Extension="xml" '
                   'ContentType="application/xml"/></Types>')
        z.writestr("_rels/.rels", '<?xml version="1.0"?><Relationships xmlns="http://'
                   'schemas.openxmlformats.org/package/2006/relationships"/>')
        z.writestr("ppt/presentation.xml",
                   '<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.'
                   'openxmlformats.org/presentationml/2006/main"/>')
        z.writestr("ppt/slides/slide1.xml", _SLIDE1)
        z.writestr("ppt/slides/slide2.xml", _SLIDE2)
        z.writestr("ppt/slides/slide3.xml", _SLIDE2)


path = os.path.join(OUT, "fixture.pptx")
_fixture_pptx(path)
tr = animations.apply_transitions(path, "push", "fast")
ok("transition applied to content slides only (title skipped)",
   tr["ok"] and tr["applied"] == 2 and tr["style"] == "push", str(tr))
an = animations.apply_entrance(path, "bounce")
ok("entrance animation applied", an["ok"] and an["applied"] == 2, str(an))
ok("motioned file is still a valid zip (OOXML)", zipfile.is_zipfile(path))
with zipfile.ZipFile(path) as zf:
    slide2 = zf.read("ppt/slides/slide2.xml").decode()
    slide1 = zf.read("ppt/slides/slide1.xml").decode()
    import xml.etree.ElementTree as _ET
    for _n in sorted(n for n in zf.namelist() if n.startswith("ppt/slides/slide")):
        _ET.fromstring(zf.read(_n))  # real parse — raises if corrupt
ok("EVERY slide part re-parses after motion (corruption guard)", True)
ok("slide XML contains the <p:transition node", "<p:transition" in slide2)
ok("slide XML contains <p:animEffect", "animEffect" in slide2)
ok("animations target EVERY bullet paragraph (<p:ap p=1..3>)",
   all(f'<p:ap p="{i}"' in slide2 for i in (1, 2, 3)), "ap targets missing")
ok("one effect per bullet (3 bullets → 3 entrance effects, NONE skipped)",
   slide2.count("presetClass=\"entr\"") == 3,
   str(slide2.count("presetClass=\"entr\"")))

# a theme-placeholder body with an EMPTY first paragraph: skip the empty one,
# animate the real bullets — never drop the last bullet.
_ENTR = 'presetClass="entr"'
_empty_lead = _slide("Lead", 3).replace(
    '<a:p><a:r><a:t>Lead one</a:t></a:r></a:p>',
    '<a:p><a:endParaRPr lang="en-US"/></a:p>')
path3 = os.path.join(OUT, "fixture3.pptx")
_fixture_pptx(path3)  # fresh, no motion yet
import io as _io
_buf = _io.BytesIO()
with zipfile.ZipFile(path3) as _zi, zipfile.ZipFile(_buf, "w", zipfile.ZIP_DEFLATED) as _zo:
    for _n in _zi.namelist():
        _zo.writestr(_n, _empty_lead if _n == "ppt/slides/slide2.xml" else _zi.read(_n))
with open(path3, "wb") as _fh:
    _fh.write(_buf.getvalue())
an3 = animations.apply_entrance(path3, "float")
s2b = zipfile.ZipFile(path3).read("ppt/slides/slide2.xml").decode()
ok("empty placeholder paragraph is skipped, real bullets still animate",
   an3["applied"] == 2 and '<p:ap p="2"' in s2b and '<p:ap p="3"' in s2b
   and '<p:ap p="1"' not in s2b and s2b.count(_ENTR) == 2,
   f"applied={an3.get('applied')} effects={s2b.count(_ENTR)}")
ok("title slide is untouched (skip_first)", "<p:transition" not in slide1)
ok("_insert_ordered puts transition before timing",
   slide2.index("<p:transition") < slide2.index("</p:sld>"))
bad = animations.apply_transitions(path, "teleport")
ok("unknown style degrades to fade honestly",
   bad["ok"] and bad["style"] == "fade", str(bad))
none = animations.apply_transitions(path, "none")
ok("transition 'none' is an honest no-op", none["applied"] is False)
path2 = os.path.join(OUT, "fixture2.pptx")
_fixture_pptx(path2)
rep = animations.apply_features(path2, "zoom", "slow", "float")
ok("apply_features reports both motions",
   rep["transitions"]["applied"] == 2 and rep["animation"]["applied"] == 2, str(rep))
again = animations.apply_features(path2, "zoom", "slow", "float")
ok("re-applying motion is an honest no-op (idempotent)",
   again["transitions"]["applied"] == 0 and again["animation"]["applied"] == 0)

# same motion path against a REAL builder deck when python-pptx exists
if doc_builder.capabilities()["pptx"]:
    r = doc_builder.build("pptx", {
        "title": "Motion", "subtitle": "test",
        "slides": [{"title": "One", "bullets": ["a", "b"]},
                   {"title": "Two", "bullets": ["c"]}],
    }, folder=OUT, resolver=resolver)
    ok("real deck builds for the motion test", r["ok"], r.get("message", "")[:60])
    from pptx import Presentation
    Presentation(r["path"])
    ok("motioned real deck still opens in python-pptx", True)

    # ── honest embedding: "resolved" ≠ "in the deck" ──
    _PNG_1PX = ("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk"
                "+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")
    tiny = os.path.join(OUT, "tiny.png")
    with open(tiny, "wb") as fh:
        fh.write(base64.b64decode(_PNG_1PX))
    ri = doc_builder.build("pptx", {
        "title": "Pics", "subtitle": "t",
        "slides": [{"kind": "image", "title": "Shot", "image": tiny,
                    "purpose": "caption for the shot"}],
    }, folder=OUT, resolver=resolver)
    ok("image slide with a real PNG embeds it (count = 1)",
       ri["ok"] and ri.get("embedded_images") == 1, str(ri.get("message", ""))[:80])
    media = [n for n in zipfile.ZipFile(ri["path"]).namelist()
             if n.startswith("ppt/media/")]
    ok("the picture really landed in ppt/media/", len(media) >= 1, str(media))
    rmiss = doc_builder.build("pptx", {
        "title": "Miss", "subtitle": "t",
        "slides": [{"kind": "image", "title": "Shot", "image": "/no/such/file.png"}],
    }, folder=OUT, resolver=resolver)
    ok("missing image is reported FAILED, never 'embedded'",
       rmiss["ok"] and rmiss.get("embedded_images") == 0
       and bool(rmiss.get("failed_images")), str(rmiss.get("failed_images")))
else:
    ok("real-deck branch skipped (no python-pptx in this env) — honest", True)

# ════════════════════════════════════════════════════ CANONICAL SERVICE
sec("services.docgen.service.generate — ONE CALL EVERYWHERE")
bad = doc_service.generate("pptx", {"title": "nope"}, folder=OUT, resolver=resolver)
ok("invalid spec never reaches the builder", not bad["ok"] and "no slides" in bad["message"])

if doc_builder.capabilities()["pptx"]:
    spec = {"title": "Canon", "slides": [
        {"kind": "title", "title": "Canon", "bullets": []},
        {"kind": "bullets", "title": "A", "bullets": ["one", "two"]},
    ]}
    r = doc_service.generate("pptx", spec, folder=OUT, resolver=resolver,
                             options={"theme": "holiday", "transition": "zoom",
                                      "speed": "slow", "animation": "float",
                                      "images": {"enabled": False}})
    ok("canonical generate reports success", r["ok"], r.get("message", "")[:70])
    ok("message reports motion honestly", "slide transitions (zoom)" in r["message"]
       and "entrance animation: float" in r["message"], r.get("message", "")[-90:])
    ok("motion block attached to result", r["motion"]["transitions"]["applied"] == 1)
    ok("images-block shape always present", r["images"]["count"] == 0)
else:
    r = doc_service.generate("pptx", {"title": "Canon", "slides": [
        {"kind": "bullets", "title": "A", "bullets": ["one"]}]},
        folder=OUT, resolver=resolver,
        options={"theme": "holiday", "transition": "zoom", "animation": "float",
                 "images": {"enabled": False}})
    ok("batteryless env refuses honestly (python-pptx cause, never a fake deck)",
       not r["ok"] and "python-pptx" in r.get("message", ""), r.get("message", "")[:90])

# ══════════════════════════════════════════════════ /doc TERMINAL WIZARD
sec("TERMINAL /doc WIZARD — numbered questions, manifest defaults, one service")
pin_prov, pin_model = serve._cli_docgen_pin("pptx")
ok("docgen pin reads THE manifest model (one source of truth)",
   pin_prov == "gemini" and pin_model == "gemini-3.8-flash",
   f"{pin_prov} {pin_model}")
ok("docx has no pin (chat backend runs it)", serve._cli_docgen_pin("docx") == (None, None))

# design[1] slides[12] images yes[1] count[2] style[3=3d render]
# provider[2=openai] transition[11=wheel] speed[2=slow] animation[1=bounce]
answers = iter(["1", "12", "1", "2", "3", "2", "11", "3", "2"])
wiz = serve._cli_doc_wizard("pptx", input_fn=lambda p: next(answers))
ok("wizard returns options + slide count",
   wiz is not None and wiz[1] == 12, str(wiz)[:80])
opts_w = wiz[0]
ok("design is the picked theme (1 = professional-dark)",
   opts_w["theme"] == "professional-dark", opts_w["theme"])
ok("image answers land (2 images, 3d render, openai)",
   opts_w["images"]["enabled"] and opts_w["images"]["count"] == 2
   and opts_w["images"]["style"] == "3d render"
   and opts_w["images"]["provider"] == "openai", str(opts_w["images"]))
ok("motion answers land (wheel / slow / bounce)",
   opts_w["transition"] == "wheel" and opts_w["speed"] == "slow"
   and opts_w["animation"] == "bounce", str(opts_w))

merged = serve._cli_merge_build_options(serve._cli_build_options("pptx", ""), opts_w)
ok("wizard answers win over flag defaults",
   merged["theme"] == "professional-dark" and merged["transition"] == "wheel"
   and merged["animation"] == "bounce"
   and merged["images"]["enabled"] is True, str(merged))

# provider with >1 model asks the exact image model (popup parity)
# design[1] slides[12] images yes[2? no: 1] count[2] style[3] provider[1=gemini]
# model[2=gemini-3.1-flash-lite-image] transition[11=wheel] speed[3=slow] anim[2=bounce]
answers2 = iter(["1", "12", "1", "2", "3", "1", "2", "11", "3", "2"])
wiz2 = serve._cli_doc_wizard("pptx", input_fn=lambda p: next(answers2))
ok("image-model question answers the exact model (1-based, like the popup)",
   wiz2 is not None and wiz2[0]["images"].get("model") == "gemini-3.1-flash-lite-image",
   str(wiz2[0]["images"]) if wiz2 else "cancelled")

# pure pickers: Enter = default, 1-based pick, bad input honest
def feed(*seq):
    """Question seam: plays the sequence, then EOFError (cancels, honest)."""
    it = iter(seq)
    def fn(p):
        try:
            return next(it)
        except StopIteration:
            raise EOFError()
    return fn
i1 = serve._cli_ask_choice("Q?", ["a", "b", "c"], default_idx=1, input_fn=feed(""))
ok("Enter picks the default", i1 == 1, str(i1))
i2 = serve._cli_ask_choice("Q?", ["a", "b"], default_idx=0, input_fn=feed("2"))
ok("number picks the option (1-based)", i2 == 1, str(i2))
i3 = serve._cli_ask_choice("Q?", ["a", "b"], default_idx=0, input_fn=feed("9"))
ok("out-of-range is honest (None)", i3 is None, str(i3))
n1 = serve._cli_ask_number("N?", 3, 30, 10, input_fn=feed("50"))
ok("number question returns None out of range", n1 is None, str(n1))
n2 = serve._cli_ask_number("N?", 3, 30, 10, input_fn=feed(""))
ok("number question defaults on Enter", n2 == 10, str(n2))

# 3) the preconfigured model reaches the Gemini wire (chat ≠ docgen)
serve._CLI_API_PROVIDER = ""            # chat is on Ollama…
serve._CLI_VAT = {"gemini": "fake-key"}  # …but the Gemini key exists
payload, _, url = serve._cli_api_request(
    "gemini", "fake-key", [{"role": "user", "content": "x"}],
    "gemini-3.8-flash", False, 8192, 0.45)
ok("the pin reaches the Gemini wire URL (model in the path)",
   "gemini-3.8-flash" in url, url[:90])
ok("thinking is disabled for outlines (whole budget = output)",
   payload["generationConfig"].get("thinkingConfig", {}).get("thinkingBudget") == 0
   and payload["generationConfig"]["maxOutputTokens"] == 8192,
   str(payload["generationConfig"])[:120])

# 4) manifest model is the single field driving pin + popup + service
ok("manifest pptx defaults carry the preconfigured model",
   registry.defaults("pptx").get("model") == "gemini-3.8-flash")
ok("the pin and the manifest cannot drift",
   serve._cli_docgen_pin("pptx")[1] == registry.defaults("pptx").get("model"))

print(f"\n\033[36mPASS {len(P)}\033[0m \033[31mFAIL {len(F)}\033[0m")
if F:
    print("FAILED:", F)
    sys.exit(1)
