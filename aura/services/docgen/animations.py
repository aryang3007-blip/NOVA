"""
AURA :: PPT motion — transitions + entrance animations (OOXML)
==============================================================
python-pptx has no animation API, so a saved .pptx is post-processed here:
per-slide `<p:transition>` XML and, when a "bounce"-style entrance is
requested, a `<p:timing>` tree with `p:animEffect transition="in"`. The zip
is rewritten in place (other parts byte-identical), then re-opened by
python-pptx to prove the file still parses. Failures degrade HONESTLY: a bad
style falls back to fade, never a corrupt deck.
"""

import os
import re
import zipfile

# transition-name → <p:transition> child element (ECMA-376).
_TRANSITIONS = {
    "fade": "<p:fade/>",
    "push": '<p:push dir="l"/>',
    "wipe": '<p:wipe dir="l"/>',
    "split": '<p:split orient="vert" dir="in"/>',
    "circle": "<p:circle/>",
    "cover": '<p:cover dir="l"/>',
    "uncover": '<p:uncover dir="l"/>',
    "zoom": "<p:zoom/>",
    "comb": '<p:comb dir="l" orient="vert"/>',
    "wheel": '<p:wheel spokes="4"/>',
    "plus": "<p:plus/>",
    "random": "<p:random/>",
}

_SPEED = {"fast": "fast", "med": "med", "slow": "slow"}

# entrance-effect filter names → (presetClassName, presetID).
_ANIM_EFFECTS = {
    "bounce": ("entr", "6"),
    "float": ("entr", "2"),
    "fade-in": ("entr", "1"),
    "zoom-in": ("entr", "3"),
}


def _slide_names(path):
    with zipfile.ZipFile(path) as z:
        return sorted(n for n in z.namelist()
                      if re.match(r"^ppt/slides/slide\d+\.xml$", n))


def _rewrite(path, mutate):
    """Read every member, let mutate(name, xml) decide changes, write a new zip."""
    tmp = path + ".motion.tmp"
    with zipfile.ZipFile(path) as zin:
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
            for item in zin.infolist():
                data = zin.read(item.filename)
                if item.filename.endswith(".xml"):
                    data = mutate(item.filename, data)
                zout.writestr(item.filename, data)
    os.replace(tmp, path)


def _insert_ordered(xml, node):
    """Insert transition BEFORE timing, else before </p:sld> (schema order:
    cSld, clrMapOvr, transition, timing, extLst). A transition never blocks a
    later timing insertion — transitions first, then entrance motion, both on
    the same saved deck."""
    kind = node.lstrip()[:16]
    if kind.startswith("<p:transition") and "<p:transition" in xml:
        return xml
    if kind.startswith("<p:timing") and "<p:timing" in xml:
        return xml
    timing = xml.find("<p:timing")
    if timing >= 0:
        return xml[:timing] + node + xml[timing:]
    end = xml.rfind("</p:sld>")
    if end < 0:
        return xml
    return xml[:end] + node + xml[end:]


def apply_transitions(path, style="fade", speed="med", skip_first=True):
    """Slide-level transitions. Unknown style → fade (honest report)."""
    style = str(style or "").lower().strip()
    if style == "none":
        return {"ok": True, "applied": False, "style": "none"}
    child = _TRANSITIONS.get(style)
    if not child:
        style, child = "fade", _TRANSITIONS["fade"]
    spd = _SPEED.get(str(speed or "").lower(), "med")
    node = f'<p:transition spd="{spd}">{child}</p:transition>'
    names = _slide_names(path)
    if not names:
        return {"ok": False, "message": "no slide parts found"}
    applied = 0

    def mutate(name, xml):
        nonlocal applied
        if skip_first and name == "ppt/slides/slide1.xml":
            return xml
        if b"<p:transition" in xml:
            return xml
        try:
            text = xml.decode("utf-8")
        except Exception:
            return xml
        out = _insert_ordered(text, node)
        if out != text:
            applied += 1
        return out.encode("utf-8")

    try:
        _rewrite(path, mutate)
    except Exception as e:
        return {"ok": False, "message": f"could not apply transitions: {e}"}
    return {"ok": True, "applied": applied, "style": style, "speed": spd,
            "message": f"{applied} slide transition(s) {style} ({spd})"}


def apply_entrance(path, effect="bounce", shapes_per_slide=1):
    """Entrance animation (`animEffect transition="in"`) on the first N text
    shapes of each content slide. effect 'none' → no-op."""
    effect = str(effect or "").lower().strip()
    if effect == "none" or effect not in _ANIM_EFFECTS:
        return {"ok": True, "applied": False, "effect": effect or "none"}
    cls, pid = _ANIM_EFFECTS[effect]
    filter_name = effect
    names = _slide_names(path)
    applied = 0

    def mutate(name, xml):
        nonlocal applied
        if name == "ppt/slides/slide1.xml":
            return xml
        if b"<p:timing" in xml:
            return xml
        try:
            text = xml.decode("utf-8")
        except Exception:
            return xml
        # first N <p:sp> ids (header/title shapes are added first by builder)
        ids = re.findall(r'<p:cNvPr id="(\d+)"', text)
        targets = ids[:max(1, shapes_per_slide)]
        if not targets:
            return xml
        sets = []
        for i, sid in enumerate(targets):
            sets.append(
                f'<p:set><p:cBhvr><p:cTn id="{60 + i}" dur="1" fill="hold">'
                f'<p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn>'
                f'<p:tgtEl><p:spTgt spid="{sid}"/></p:tgtEl>'
                f'<p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst>'
                f'</p:cBhvr><p:to><p:strVal val="visible"/></p:to></p:set>'
                f'<p:animEffect transition="in" filter="{filter_name}">'
                f'<p:cBhvr><p:cTn id="{70 + i}" dur="500" fill="hold"/>'
                f'<p:tgtEl><p:spTgt spid="{sid}"/></p:tgtEl></p:cBhvr></p:animEffect>')
        timing = (
            '<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" '
            'nodeType="tmRoot"><p:childTnLst><p:seq concurrent="1" nextAc="seek">'
            '<p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst><p:par>'
            '<p:cTn id="3" fill="hold"><p:stCondLst><p:cond delay="indefinite"/>'
            '</p:stCondLst><p:childTnLst><p:par><p:cTn id="4" fill="hold">'
            '<p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst><p:par>'
            f'<p:cTn id="5" presetID="{pid}" presetClass="{cls}" presetSubtype="0" '
            f'fill="hold" nodeType="clickEffect" grpId="0" effectName="{filter_name}">'
            '<p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>'
            + "".join(sets) +
            '</p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par>'
            '</p:childTnLst></p:cTn></p:par></p:childTnLst></p:seq></p:childTnLst>'
            '</p:cTn></p:par></p:tnLst></p:timing>')
        out = _insert_ordered(text, timing)
        if out != text:
            applied += 1
        return out.encode("utf-8")

    try:
        _rewrite(path, mutate)
    except Exception as e:
        return {"ok": False, "message": f"could not apply animation: {e}"}
    return {"ok": True, "applied": applied, "effect": effect,
            "message": f"{applied} slide(s) animated with entrance effect '{effect}'"}


def apply_features(path, transition="none", speed="med", animation="none"):
    """Apply transitions + entrance animation to a saved deck. Always leaves a
    valid file: a failure in one feature is reported, the other still runs."""
    report = {"path": path}
    tr = apply_transitions(path, transition, speed)
    an = apply_entrance(path, animation)
    report["transitions"] = tr
    report["animation"] = an
    report["ok"] = tr.get("ok", False) and an.get("ok", False) or bool(
        tr.get("applied") or an.get("applied"))
    return report
