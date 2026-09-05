"""
AURA :: Document Generation Service (CANONICAL)
================================================
The ONE build entry the app (bridge /api/action doc_build), the terminal
(/doc), the PPT Builder popup and the tests all call:

    services.docgen.service.generate(kind, spec, folder, resolver, options)

options = {
  "theme":      "holiday" | "neon" | ...        (overrides spec.theme)
  "transition": "fade" | "push" | ... | "none"
  "speed":      "fast" | "med" | "slow"
  "animation":  "bounce" | "float" | "fade-in" | "zoom-in" | "none"
  "images":     {"enabled":true,"count":1,"style":"...","provider":"gemini"}
}

The frontend picks knobs; this function owns rendering, AI images, motion,
validation and the honest report.
"""

import os

from ..registry import defaults as manifest_defaults, feature as manifest_feature
from . import animations as animations_mod
from . import builder as builder_mod
from . import images as images_mod
from . import outline as outline_mod
from . import visuals as visuals_mod


def capabilities(key_fn=None):
    caps = builder_mod.capabilities()
    caps["defaultFolder"] = builder_mod.default_folder()
    caps["themes"] = _themes()
    caps["transitions"] = _transitions()
    caps["animations"] = _animations()
    caps["images"] = images_mod.availability(key_fn)
    return caps


def _themes():
    try:
        from ..registry import themes as _t
        return _t()
    except Exception:
        return list(builder_mod.THEMES.keys())


def _transitions():
    try:
        from ..registry import transitions as _t
        return _t()
    except Exception:
        return list(animations_mod._TRANSITIONS.keys())


def _animations():
    try:
        from ..registry import animations as _a
        return _a()
    except Exception:
        return ["none"] + list(animations_mod._ANIM_EFFECTS.keys())


def generate(kind, spec, folder=None, resolver=None, options=None):
    opts = dict(options or {})
    if not isinstance(spec, dict):
        return {"ok": False, "message": "Bad spec: expected an object."}

    # 1) validate on every path — the same python rule for app + terminal.
    spec, err = outline_mod.validate(kind, spec)
    if err:
        return {"ok": False, "message": err}

    # 2) theme override (popup picks a design; spec is validated below).
    theme = str(opts.get("theme") or "").strip()
    if theme:
        spec = {**spec, "theme": theme}
    if not spec.get("theme"):
        spec = {**spec, "theme": manifest_defaults("pptx").get("theme", "professional-dark")}

    # 3) VISUAL RESOLUTION ENGINE (search → AI → native fallback):
    #    web/reference imagery is searched FIRST; AI image generation is a
    #    fallback (and never the default for photo/reference visuals);
    #    charts/diagrams are drawn natively; a 429 → native visual, and the
    #    deck ALWAYS completes. The images-only key architecture + budget
    #    guard live inside images.generate and are untouched.
    image_report = {"embedded": [], "failed": [], "native": [], "count": 0,
                    "sources": {"web": 0, "ai": 0, "native": 0, "none": 0},
                    "details": []}
    img_opts = opts.get("images") or {}
    if img_opts.get("enabled"):
        base = folder or builder_mod.default_folder()
        outdir = os.path.join(os.path.expanduser(base), "images")
        spec, image_report = visuals_mod.resolve_deck(
            spec, img_opts, str(spec.get("title") or ""), outdir)

    # 4) render (same builder the app always used).
    res = builder_mod.build(kind, spec, folder=folder, resolver=resolver)
    if not res.get("ok"):
        if image_report["failed"]:
            res["failed_images"] = image_report["failed"]
        return res

    # 4b) honest visual report: the BUILDER's embedding count is the truth —
    #     a resolved/generated file that failed to render is reported, never
    #     claimed. Native visuals are counted separately (they are real deck
    #     visuals but not "embedded images").
    builder_native = res.get("native_visuals") or []
    if image_report.get("count"):
        built = res.get("embedded_images")
        if isinstance(built, int) and built != image_report["count"]:
            image_report["count"] = built
            for f in (res.get("failed_images") or []):
                if f not in image_report["failed"]:
                    image_report["failed"].append(f)
    if builder_native and len(builder_native) >= len(image_report.get("native") or []):
        image_report["native"] = builder_native  # builder is the truth

    # 5) motion on the finished file — pptx only, never on xlsx/docx.
    motion = None
    if kind == "pptx" and res.get("path"):
        try:
            motion = animations_mod.apply_features(
                res["path"],
                transition=str(opts.get("transition") or "none"),
                speed=str(opts.get("speed") or "med"),
                animation=str(opts.get("animation") or "none"))
        except Exception:
            motion = {"ok": False, "message": "motion failed but deck is valid"}

    res["images"] = image_report
    res["motion"] = motion
    extras = []
    src = image_report.get("sources") or {}
    if src.get("web"):
        extras.append(f"{src['web']} visual(s) found by image search")
    if src.get("ai"):
        extras.append(f"{src['ai']} AI image(s) generated")
    if image_report.get("native"):
        extras.append(f"{len(image_report['native'])} native visual(s)")
    if image_report["failed"]:
        extras.append(f"visuals skipped: {'; '.join(image_report['failed'][:2])}")
    if motion and motion.get("transitions", {}).get("applied"):
        t = motion["transitions"]
        extras.append(f"{t['applied']} slide transitions ({t['style']})")
    if motion and motion.get("animation", {}).get("applied"):
        extras.append(f"entrance animation: {motion['animation']['effect']}")
    base_msg = res.get("message") or "Created."
    res["message"] = base_msg + ((" — " + ", ".join(extras) + ".") if extras else "")
    return res
