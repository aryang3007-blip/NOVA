"""
AURA :: Visual Resolution Engine
================================
The step between "the outline says a slide needs a visual" and "the deck has
one". ONE clean abstraction (no scattered conditionals in the generator):

    VISUAL REQUEST (slide.visual / legacy @gen marker / inferred)
        │
        ├─ type in {diagram, chart}       → NATIVE PPT visual (shapes/bars)
        ├─ type in {photo, reference}     → SEARCH  → AI  → native fallback
        ├─ type in {illustration, ...}    → AI      → native fallback
        └─ mode "web"      → SEARCH only  → native fallback (never AI)
          mode "none"      → native only
          mode "ai"        → AI only      → native fallback

Guard rails everywhere:
  • AI generation is a FALLBACK, not the default — scientific/reference/photo
    visuals search authoritative sources first (NASA, Wikimedia, Openverse,
    general web through the SAME ddgs package websearch uses).
  • 429/quota from an image provider → ONE honest note → native fallback →
    the deck STILL completes. No endless retry (images.generate already caps
    its own retries; this layer never loops on quota).
  • The separate images-only key architecture is untouched — generation is
    delegated to services.docgen.images, which reads ONLY the keyId slot.
  • The selected image model (UI) is passed straight through to generation.
  • Every decision lands in a per-slide report the final summary reads aloud.

All I/O sits behind injectable seams (search_fn / download_fn / generate_fn)
so the full pipeline is testable offline with fakes.
"""

import re
from typing import Any, Dict, Tuple

from ..registry import defaults as manifest_defaults
from . import image_sources as sources_mod

# ── vocabulary ──────────────────────────────────────────────────────────────
SEARCH_FIRST_TYPES = {"photo", "reference"}       # real-world / authoritative
AI_ONLY_TYPES = {"illustration", "artwork", "concept", "fictional"}
NATIVE_TYPES = {"diagram", "chart", "icon"}
ALL_TYPES = {"none"} | SEARCH_FIRST_TYPES | AI_ONLY_TYPES | NATIVE_TYPES

MODES = ("smart", "web", "ai", "none")
SOURCE_PREFERENCES = ("auto", "nasa", "wikimedia", "openverse", "general")

# keywords → type when the outline didn't say (legacy + partial outlines)
_KEYWORDS = [
    (("chart", "graph", "statistic", "data", "metric"), "chart"),
    (("diagram", "flow", "process", "architecture", "cycle", "timeline"), "diagram"),
    (("futuristic", "concept", "fictional", "imaginary", "mascot", "custom",
      "illustration", "artwork", "render"), "illustration"),
    (("scientific", "reference", "nasa", "planet", "solar", "anatomy", "map",
      "historic", "monument", "photo", "photograph"), "reference"),
]
_PHOTO_HINTS = ("person", "landscape", "building", "place", "product", "logo",
                "city", "portrait", "flag", "animal", "plant")

_NATIVE_REASON = {
    "design": "drawn natively with PowerPoint shapes — no search or AI call used",
    "no_search": "no matching image was found in the configured sources",
    "blocked": "the visual budget was reached before a generate call",
    "quota": "the image provider returned HTTP 429 (quota) — no retry loop",
    "error": "AI image generation failed",
    "mode": "this visual-source mode does not call AI generation",
    "no_external": "external images are disabled — native visual drawn instead",
}


def infer_type(slide: Dict[str, Any]) -> str:
    """Decide what kind of visual a slide needs when the outline said nothing."""
    text = " ".join(str(slide.get(k) or "") for k in
                    ("title", "purpose", "image", "notes")).lower()
    for words, kind in _KEYWORDS:
        if any(w in text for w in words):
            return kind
    if any(w in text for w in _PHOTO_HINTS):
        return "photo"
    return "photo"   # default: real-world photo → search first, no AI by default


def classify(slide: Dict[str, Any]) -> Tuple[str, Dict[str, Any]]:
    """
    Normalise a slide's visual request.
    Returns (type, request) where request = {"search_query", "ai_prompt",
    "source_preference", ...} with sensible defaults filled in.
    """
    v = slide.get("visual") or {}
    if not isinstance(v, dict):
        v = {}
    vtype = str(v.get("type") or "").lower().strip()
    if vtype not in ALL_TYPES:
        vtype = infer_type(slide)
    title = str(slide.get("title") or "Visual")
    purpose = str(slide.get("purpose") or "")
    search_query = str(v.get("search_query") or "").strip() \
        or " ".join(x for x in (purpose, title) if x).strip()
    ai_prompt = str(v.get("ai_prompt") or "").strip() \
        or f"{title}. {purpose}".strip() or title
    pref = str(v.get("source_preference") or "").lower().strip()
    if pref not in SOURCE_PREFERENCES:
        pref = "auto"
    return vtype, {"search_query": search_query, "ai_prompt": ai_prompt,
                   "source_preference": pref,
                   "chart": v.get("chart") or slide.get("chart"),
                   "steps": v.get("steps") or slide.get("steps")
                   or slide.get("bullets") or []}


def _native_for(slide, vtype, reason, extra=None):
    """Build the slide-level native visual payload (drawn by the builder).
    `reason` may be a key OR the real failure message — the report keeps the
    actual cause (429/quota/missing key) instead of a vague label."""
    reason = str(reason or "")[:160]
    title = str(slide.get("title") or "Visual")
    if vtype == "chart" or (extra or {}).get("data"):
        data = (extra or {}).get("data") or []
        return {"kind": "chart",
                "data": [{"label": str(d.get("label") or ""), "value": d.get("value")}
                         for d in data if isinstance(d, dict)][:6],
                "reason": _NATIVE_REASON.get(reason, reason)}
    steps = (extra or {}).get("steps") or []
    if vtype == "diagram" and len([s for s in steps if str(s).strip()]) >= 2:
        return {"kind": "diagram",
                "steps": [str(s)[:220] for s in steps if str(s).strip()][:6],
                "reason": _NATIVE_REASON.get(reason, reason)}
    return {"kind": "icon", "label": title,
            "reason": _NATIVE_REASON.get(reason, reason)}


# ── seams (module-level so tests can monkeypatch, like images.generate) ────

def search_fn(query, preference="auto", kind="photo", max_results=8):
    return sources_mod.search(query, preference=preference, kind=kind,
                              max_results=max_results)


def download_fn(url, outdir):
    return sources_mod.download(url, outdir)


def generate_fn(prompt, style, provider, outdir, model=None, **kw):
    from . import images as images_mod
    return images_mod.generate(prompt, style=style, provider=provider,
                               outdir=outdir, model=model, **kw)


# ── resolution steps ────────────────────────────────────────────────────────

def _search_then(slide, req, vtype, opts, outdir, sfn, dfn):
    """Try configured image sources. Returns a result dict or None."""
    pref = req["source_preference"]
    q = req["search_query"]
    found = sfn(q, preference=pref,
                kind="photo" if vtype == "photo" else "reference")
    results = (found or {}).get("results") or []
    notes = (found or {}).get("notes") or []
    if not results:
        return None, (found or {}).get("message") or "no results"
    from . import image_sources as src
    attempts = src.pick(results, q)
    last = "no candidate passed validation"
    for cand in attempts:
        path, err, meta = dfn(cand.get("url"), outdir)
        if path:
            return {
                "source": "web", "path": path, "ok": True,
                "attribution": cand.get("attribution") or "",
                "license": cand.get("license") or "",
                "url": cand.get("url") or "",
                "title": cand.get("title") or "",
                "note": f"sourced from {cand.get('source')}: {cand.get('title') or q}",
            }, None
        last = err or last
    return None, last


def _ai_then(slide, req, opts, outdir, gfn):
    """AI generation (delegates to images.generate — strict images-only key,
    budget-before-wire, pacing, capped 429/503 retries all inside)."""
    provider = str(opts.get("provider") or "gemini")
    style = str(opts.get("style") or "flat illustration")
    model = str(opts.get("model") or "").strip() or None
    prompt = req["ai_prompt"]
    r = gfn(prompt, style, provider, outdir, model=model,
            min_interval=opts.get("minInterval"))
    if r and r.get("ok"):
        return ({"source": "ai", "path": r.get("path"), "ok": True,
                 "model": r.get("model") or model,
                 "keyId": r.get("keyId"), "paced": r.get("paced"),
                 "note": f"AI image ({r.get('model') or model})"}, None)
    msg = (r or {}).get("message") or "AI generation failed"
    reason = "blocked" if (r or {}).get("blocked") else \
             ("quota" if re.search(r"\b429\b|quota", msg, re.I) else "error")
    return None, _native_note(reason, msg)


def _native_note(reason, msg=""):
    return f"{_NATIVE_REASON.get(reason, reason)} — {msg}"[:200] if msg \
        else _NATIVE_REASON.get(reason, reason)


def resolve_slide(slide, opts, topic="", outdir=None,
                  search_fn_=None, download_fn_=None, generate_fn_=None):
    """
    Resolve ONE slide's visual. Returns {slide, status, source?, report}.
    status ∈ "web" | "ai" | "native" | "none".
    """
    sfn = search_fn_ or search_fn
    dfn = download_fn_ or download_fn
    gfn = generate_fn_ or generate_fn
    mode = str(opts.get("mode") or manifest_defaults("pptx")
               .get("images", {}).get("mode") or "smart").lower()
    if mode not in MODES:
        mode = "smart"
    marker = str(slide.get("image") or "")
    vtype, req = classify(slide)
    strip = dict(slide)

    def finish(status, src=None, native_reason="fallback"):
        out = {**strip}
        if src and src.get("path"):
            meta = {"status": status, "source": src["source"],
                    "model": src.get("model"), "attribution": src.get("attribution"),
                    "license": src.get("license"), "url": src.get("url"),
                    "note": src.get("note") or ""}
            out["_visualMeta"] = meta
            out["image"] = src["path"]
        elif status == "native":
            nv = _native_for(strip, vtype, native_reason,
                             {"steps": req.get("steps"), "data": req.get("chart")})
            out["_visualMeta"] = {"status": "native", "source": "native",
                                  "note": nv.get("reason") or ""}
            out["_nativeVisual"] = nv
            out.pop("image", None)
        else:
            out["_visualMeta"] = {"status": status, "source": None, "note": ""}
        return {"slide": out, "status": status, "report": out["_visualMeta"]}

    # 0) explicit marker means "generate" (legacy outlines / AI mode popup)
    if marker.lower().startswith("@gen:"):
        res, note = _ai_then(strip, req, opts, outdir, gfn)
        if res:
            return finish("ai", res)
        return finish("native", native_reason=(note or _note_reason(note)))

    # 1) nothing requested at all
    if vtype == "none":
        return finish("none")

    # 2) native-only types: NEVER spend an API call on a chart/diagram
    if vtype in NATIVE_TYPES:
        return finish("native", native_reason="design")

    # 3) mode "none": no external images — draw it instead
    if mode == "none":
        return finish("native", native_reason="no_external")

    # 4) search-first types (photo/reference) — and, in "web" mode, ALL types
    search_first = vtype in SEARCH_FIRST_TYPES or mode == "web"
    if mode in ("smart", "web") and search_first:
        res, note = _search_then(strip, req, vtype, opts, outdir, sfn, dfn)
        if res:
            return finish("web", res)
        if mode == "web":
            # web-only mode never calls AI — draw the visual instead
            return finish("native", native_reason="no_search")
        # smart: search failed → AI fallback below

    # 5) AI (smart default for illustration; ai mode; search-failed fallback)
    if mode in ("smart", "ai"):
        res, note = _ai_then(strip, req, opts, outdir, gfn)
        if res:
            return finish("ai", res)
        # 6) quota / budget / model failure → native visual, deck continues.
        #    The native visual's note carries the REAL reason (429/quota/
        #    missing key) so the report is honest, never a vague "failed".
        return finish("native", native_reason=(note or _note_reason(note)))

    return finish("native", native_reason="mode")


def _note_reason(note):
    """Map an AI failure note back to the honest native-reason key."""
    s = str(note or "")
    if "429" in s or "quota" in s.lower():
        return "quota"
    if "budget" in s.lower():
        return "blocked"
    return "error"


def resolve_deck(spec, opts, topic="", outdir=None,
                 search_fn_=None, download_fn_=None, generate_fn_=None):
    """
    Resolve every visual-bearing slide in the spec (up to the count cap).
    Returns (spec, report) with report = {embedded, failed, native,
    sources, details, count}.
    """
    img_opts = opts or {}
    if not img_opts.get("enabled"):
        return spec, {"embedded": [], "failed": [], "native": [], "count": 0,
                      "sources": {"web": 0, "ai": 0, "native": 0,
                                  "none": 0},
                      "details": []}
    count = max(1, min(3, int(img_opts.get("count") or 1)))
    slides = [dict(s) for s in spec.get("slides") or []]
    report = {"embedded": [], "failed": [], "native": [], "count": 0,
              "sources": {"web": 0, "ai": 0, "native": 0, "none": 0},
              "details": []}
    made = 0
    for i, s in enumerate(slides):
        if made >= count:
            break
        # a slide "needs a visual": image kind, media kind, visual.required,
        # or an explicit @gen marker.
        needs = str(s.get("kind") or "").lower() in ("image", "media") \
            or bool((s.get("visual") or {}).get("required")) \
            or str(s.get("image") or "").startswith("@gen:")
        if not needs:
            continue
        r = resolve_slide(s, img_opts, topic, outdir,
                          search_fn_=search_fn_, download_fn_=download_fn_,
                          generate_fn_=generate_fn_)
        slides[i] = r["slide"]
        st = r["status"]
        meta = r["report"]
        report["details"].append({"slide": i + 1, "source": meta.get("source"),
                                  "status": st, "note": meta.get("note"),
                                  "attribution": meta.get("attribution"),
                                  "url": meta.get("url"),
                                  "model": meta.get("model")})
        report["sources"][st] = report["sources"].get(st, 0) + 1
        if st == "web":
            report["embedded"].append(f"slide {i + 1}")
            made += 1
        elif st == "ai":
            report["embedded"].append(f"slide {i + 1}")
            made += 1
        elif st == "native":
            report["native"].append(f"slide {i + 1}")
            made += 1
        else:  # none: a requested visual that intentionally stays empty
            report["embedded"].append(f"slide {i + 1}")
            made += 1
    report["count"] = len(report["embedded"])
    return {**spec, "slides": slides}, report
