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

    # 3) AI images: @gen markers + auto-visuals → real files in the deck dir.
    image_report = {"embedded": [], "failed": [], "count": 0}
    img_opts = opts.get("images") or {}
    if img_opts.get("enabled"):
        base = folder or builder_mod.default_folder()
        outdir = os.path.join(os.path.expanduser(base), "images")
        spec, embedded, failed = outline_mod.expand_image_markers(
            spec, img_opts, str(spec.get("title") or ""), outdir)
        image_report = {"embedded": embedded, "failed": failed,
                        "count": len(embedded)}

    # 4) render (same builder the app always used).
    res = builder_mod.build(kind, spec, folder=folder, resolver=resolver)
    if not res.get("ok"):
        if image_report["failed"]:
            res["failed_images"] = image_report["failed"]
        return res

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
    if image_report["count"]:
        extras.append(f"{image_report['count']} AI image(s) embedded")
    if image_report["failed"]:
        extras.append(f"images skipped: {'; '.join(image_report['failed'][:2])}")
    if motion and motion.get("transitions", {}).get("applied"):
        t = motion["transitions"]
        extras.append(f"{t['applied']} slide transitions ({t['style']})")
    if motion and motion.get("animation", {}).get("applied"):
        extras.append(f"entrance animation: {motion['animation']['effect']}")
    base_msg = res.get("message") or "Created."
    res["message"] = base_msg + ((" — " + ", ".join(extras) + ".") if extras else "")
    return res
