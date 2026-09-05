"""
AURA :: shared outline prompts + validation (python side)
==========================================================
The terminal (/doc) and any python caller build the model prompt from THIS
module so the language used with the model is one vocabulary. The browser
keeps its own doc-agent (it talks to providers the browser resolved); the
manifest + builder are the shared parts, and python validate_spec runs on
EVERY build path (terminal + bridge) so a bad outline dies before bytes hit
disk either way.
"""

import json
from typing import Any, Dict, List, Optional, Tuple

SCHEMAS = {
    "pptx": ('{"title":"…","slides":[{"kind":"title|bullets|two-column|process|timeline|'
             'stats|comparison|quote|conclusion|references|image","title":"…","purpose":"…",'
             '"bullets":["…"],"notes":"…","image":"path|@gen:style|https://…",'
             '"visual":{"required":true,"type":"photo|reference|illustration|diagram|chart|icon|none",'
             '"search_query":"…","ai_prompt":"…","source_preference":"auto"}}]}'),
    "xlsx": '{"title":"…","sheets":[{"name":"…","columns":["…"],"rows":[[1,"…"]]}]}',
    "docx": '{"title":"…","sections":[{"heading":"…","paragraphs":["…"],"bullets":["…"]}]}',
}

RULES = {
    "pptx": ("8-12 content slides unless a count was requested. Slide 1 kind 'title'. "
             "Last slide 'conclusion' + 'references'. Every content slide: 3-5 real bullets "
             "(8-18 words) and speaker notes. No invented facts. If an image source or "
             "@gen:style marker is supplied, use kind 'image' slides for it. "
             "For slides that truly need a visual, add the 'visual' object on kind 'image' "
             "slides: type 'photo' or 'reference' for real-world/scientific imagery "
             "(search_query = what to search, e.g. 'NASA solar system planets'), "
             "type 'illustration' only for custom/fictional art (ai_prompt = exact art "
             "prompt), type 'diagram' for process/flow visuals (put the steps in the "
             "slide's 'steps'), type 'chart' for data bars ('stats' entries), type 'none' "
             "when no visual helps. You describe WHAT is needed; the deck engine decides "
             "HOW to obtain it — never force image generation for real photos."),
    "xlsx": ("One sheet, 3-6 columns, 8-20 rows; numbers are JSON numbers."),
    "docx": ("4-8 sections; each heading with 1-3 paragraphs of real content."),
}


def system_prompt(kind: str, slides: int = 0, audience: str = "",
                  theme: str = "") -> str:
    rules = RULES.get(kind, "")
    shape = SCHEMAS.get(kind, "{}")
    p = (f"You are a world-class document designer. Reply with ONE JSON object and nothing "
         f"else — no prose, no markdown fences.\n\nShape: {shape}\n\nRules: {rules}\n"
         + (f"The user asked for {slides} slides.\n" if slides else "")
         + (f"Audience: {audience}.\n" if audience else "")
         + (f"Visual theme: {theme}.\n" if theme else ""))
    return p


def user_prompt(topic: str, details: str = "") -> str:
    return f"Topic: {topic}\n" + (f"Extra instructions: {details}\n" if details else "") \
        + "Produce the JSON now."


def validate(kind: str, obj: Any) -> Tuple[Optional[Dict[str, Any]], str]:
    """True-cause validation used by every python caller + the build service."""
    if not isinstance(obj, dict):
        return None, "The model returned JSON that was not an object."
    if kind == "pptx":
        if not (isinstance(obj.get("slides"), list) and obj["slides"]):
            return None, "The model outline had no slides."
    elif kind == "xlsx":
        if not (isinstance(obj.get("sheets"), list) and obj["sheets"]):
            return None, "The model outline had no sheets."
    elif kind == "docx":
        if not (isinstance(obj.get("sections"), list) and obj["sections"]):
            return None, "The model outline had no sections."
    else:
        return None, f"Unknown document kind '{kind}'."
    return obj, ""


def expand_image_markers(spec: Dict[str, Any], images_opts: Optional[Dict[str, Any]],
                         topic: str, outdir: str) -> Tuple[Dict[str, Any], List[str], List[str]]:
    """
    Turn '@gen:style' markers on image slides into real generated files.
    Returns (spec, embedded, failed).
    """
    opts = images_opts or {}
    if not opts.get("enabled"):
        return spec, [], []
    from . import images as images_mod
    provider = opts.get("provider") or "gemini"
    model = str(opts.get("model") or "").strip() or None
    style = opts.get("style") or "flat illustration"
    count = max(1, min(3, int(opts.get("count") or 1)))
    embedded, failed, map_ = [], [], {}

    slides = [dict(s) for s in spec.get("slides") or []]
    attempted = set()   # slide indexes already asked the image API — a failed
    # marker must NEVER be generated twice (that was the duplicate 429 log:
    # marker try + auto-visual retry on the SAME slide = two billed calls).
    # 1) markers already authored by the outline
    for i, s in enumerate(slides):
        img = str(s.get("image") or "")
        if img.lower().startswith("@gen:"):
            attempted.add(i)
            style_hint = img.split(":", 1)[1].strip() or style
            prompt = f"{s.get('title') or 'Visual'} for a deck about {topic}"
            r = images_mod.generate(prompt, style_hint, provider, outdir,
                                    model=model)
            if r.get("ok"):
                slides[i] = {**s, "image": r["path"]}
                embedded.append(f"slide {i + 1}")
                map_[r["path"]] = r
            else:
                failed.append(f"slide {i + 1}: {r.get('message')}")
                slides[i] = {**s, "image": ""}
    # 2) auto-visuals for image-kind slides with no source, up to `count`
    made = 0
    for i, s in enumerate(slides):
        if made >= count:
            break
        if i in attempted:
            continue
        if str(s.get("kind") or "").lower() in ("image", "media") and not s.get("image"):
            prompt = f"{s.get('title') or 'Visual'} for a deck about {topic}"
            r = images_mod.generate(prompt, style, provider, outdir, model=model)
            if r.get("ok"):
                slides[i] = {**s, "image": r["path"]}
                embedded.append(f"slide {i + 1}")
                made += 1
            else:
                failed.append(f"slide {i + 1}: {r.get('message')}")
    return {**spec, "slides": slides}, embedded, failed
