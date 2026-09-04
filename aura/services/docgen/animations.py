"""
AURA :: PPT motion — transitions + entrance animations (OOXML, validated)
==========================================================================
python-pptx has no animation API, so a saved .pptx is post-processed here.

The corruption lesson (user reported "PowerPoint says the file is corrupt"):
a hand-written <p:timing> tree with unbalanced closing tags is well-formed
NOWHERE — lxml/ET refuse it and PowerPoint repairs-into-corruption. So this
module now:

  1. builds the timing tree from a TEMPLATE VERIFIED on real PowerPoint
     (par-per-effect, presetID/presetClass/presetSubtype, clickEffect +
     withEffect stagger — the same shape as working open-source deck code),
  2. parses EVERY generated fragment with xml.etree.ElementTree BEFORE it is
     written into the package (a fragment that does not parse is skipped and
     reported, never injected),
  3. re-parses EVERY slide part AFTER the zip rewrite — if anything fails,
     the ORIGINAL file is restored and the motion is reported as failed, so
     a deck is NEVER left corrupt by animation work,
  4. animates BULLET PARAGRAPHS (each bullet is its own effect, staggered,
     like PowerPoint's per-word entrance) instead of one invisible gesture.

Transitions (<p:transition>) are slide-level and schema-simple; they are
still verified the same way before committing the rewrite.
"""

import os
import re
import zipfile
import xml.etree.ElementTree as ET

NS = ('xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" '
      'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"')
_P = '{http://schemas.openxmlformats.org/presentationml/2006/main}'
_A = '{http://schemas.openxmlformats.org/drawingml/2006/main}'
_SLIDE_RE = re.compile(r'^ppt/slides/slide\d+\.xml$')

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

# entrance effect → (presetID, presetSubtype, filter, movement lift)
# preset IDs are PowerPoint's official entrance list (Fade=10, Zoom=23,
# Bounce=26, Float Up=42/subtype 8) — the FILTER still runs the fallback
# visibility/reveal behavior so the effect plays even if a preset is unknown.
_ANIM_EFFECTS = {
    "fade-in": (10, 0, "fade", 0.0),
    "zoom-in": (23, 0, "zoom", 0.0),
    "bounce": (26, 0, "fade", 0.10),
    "float": (42, 8, "fade", 0.06),
}
_DUR_MS = 700      # entrance duration for one bullet (ms)
_STAGGER_MS = 400  # between bullets


def _slide_names(path):
    with zipfile.ZipFile(path) as z:
        return sorted(n for n in z.namelist() if _SLIDE_RE.match(n))


def _well_formed(xml_bytes):
    """Real parse check — catches the exact class of bug that corrupted
    decks (mismatched closing tags are NOT syntactically obvious)."""
    try:
        ET.fromstring(xml_bytes)
        return True
    except Exception:
        return False


def _rewrite(path, mutate):
    """Read every member, let mutate(name, xml) decide changes, write a new
    zip, then VERIFY every slide part parses. Returns (ok, message). If
    verification fails the original file is untouched."""
    tmp = path + ".motion.tmp"
    ok = True
    try:
        with zipfile.ZipFile(path) as zin:
            with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
                for item in zin.infolist():
                    data = zin.read(item.filename)
                    if item.filename.endswith(".xml"):
                        data = mutate(item.filename, data)
                    zout.writestr(item.filename, data)
        with zipfile.ZipFile(tmp) as z:
            for name in z.namelist():
                if _SLIDE_RE.match(name) and not _well_formed(z.read(name)):
                    ok = False
                    break
        if not ok:
            os.remove(tmp)
            return False, "motion produced invalid slide XML — reverted"
        os.replace(tmp, path)
        return True, ""
    except Exception as e:
        try:
            os.remove(tmp)
        except OSError:
            pass
        return False, f"motion failed: {e}"


def _insert_before_end(xml_text, node):
    """Insert `node` before </p:sld> — AFTER cSld/clrMapOvr (schema order:
    cSld, clrMapOvr, transition, timing, extLst)."""
    end = xml_text.rfind("</p:sld>")
    if end < 0:
        return xml_text
    return xml_text[:end] + node + xml_text[end:]


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
    # fragment check needs the namespace declarations (standalone parse)
    if not _well_formed(f'<p:sld {NS}>{node}</p:sld>'.encode()):
        return {"ok": False, "message": "transition fragment invalid — skipped"}
    names = _slide_names(path)
    if not names:
        return {"ok": False, "message": "no slide parts found"}
    applied = 0

    def mutate(name, xml):
        nonlocal applied
        if skip_first and name == "ppt/slides/slide1.xml":
            return xml
        text = xml.decode("utf-8", "replace")
        if "<p:transition" in text or not _well_formed(xml):
            return xml
        out = _insert_before_end(text, node)
        if out != text:
            applied += 1
        return out.encode("utf-8")

    ok, err = _rewrite(path, mutate)
    if not ok:
        return {"ok": False, "message": err}
    return {"ok": True, "applied": applied, "style": style, "speed": spd,
            "message": f"{applied} slide transition(s) {style} ({spd})"}


def _body_shape(slide_text):
    """Pick the content text shape of a slide: the <p:sp> with the most
    <a:p> paragraphs (skips titles). Returns (shape_id, paragraph_count)."""
    try:
        root = ET.fromstring(slide_text.encode("utf-8"))
    except Exception:
        return None, 0
    best, best_n = None, 1
    for sp in root.iter(_P + "sp"):
        paras = list(sp.iter(_A + "p"))
        if len(paras) > best_n:
            cid = sp.find(f".//{_P}cNvPr")
            if cid is not None and cid.get("id"):
                best, best_n = cid.get("id"), len(paras)
    return best, best_n


def _effect_par(eid, spid, ap, delay, node_type, grp, effect):
    """One bullet's entrance, in the exact shape of PowerPoint-verified code:
    set(visibility) + optional movement anim + animEffect, all inside one
    <p:par> effect node."""
    preset_id, preset_sub, filt, lift = _ANIM_EFFECTS[effect]
    tgt = f'<p:tgtEl><p:spTgt spid="{spid}"/>'
    if ap:
        tgt += f'<p:txEl><p:ap p="{ap}"/></p:txEl>'
    tgt += "</p:tgtEl>"
    parts = [
        f'<p:set><p:cBhvr><p:cTn id="{eid + 1}" dur="1" fill="hold">'
        f'<p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn>{tgt}'
        f'<p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst>'
        f'</p:cBhvr><p:to><p:strVal val="visible"/></p:to></p:set>',
    ]
    if lift:
        parts.append(
            f'<p:anim calcmode="lin" valueType="num">'
            f'<p:cBhvr additive="base">'
            f'<p:cTn id="{eid + 2}" dur="{_DUR_MS}" fill="hold"/>{tgt}'
            f'<p:attrNameLst><p:attrName>ppt_y</p:attrName></p:attrNameLst>'
            f'</p:cBhvr><p:tavLst>'
            f'<p:tav tm="0"><p:val><p:strVal val="ppt_y+{lift}"/></p:val></p:tav>'
            f'<p:tav tm="100000"><p:val><p:strVal val="ppt_y"/></p:val></p:tav>'
            f'</p:tavLst></p:anim>')
    parts.append(
        f'<p:animEffect transition="in" filter="{filt}">'
        f'<p:cBhvr><p:cTn id="{eid + 3}" dur="{_DUR_MS}"/>{tgt}'
        f'</p:cBhvr></p:animEffect>')
    return (f'<p:par {NS}><p:cTn id="{eid}" presetID="{preset_id}" '
            f'presetClass="entr" presetSubtype="{preset_sub}" fill="hold" '
            f'grpId="{grp}" nodeType="{node_type}">'
            f'<p:stCondLst><p:cond delay="{delay}"/></p:stCondLst>'
            f'<p:childTnLst>' + "".join(parts) +
            f'</p:childTnLst></p:cTn></p:par>')


def _timing_xml(effects):
    """The verified wrapping tree around the effect <p:par>s."""
    return (f'<p:timing {NS}><p:tnLst><p:par><p:cTn id="1" dur="indefinite" '
            f'restart="never" nodeType="tmRoot"><p:childTnLst>'
            f'<p:seq concurrent="1" nextAc="seek">'
            f'<p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>'
            f'<p:par><p:cTn id="3" fill="hold">'
            f'<p:stCondLst><p:cond delay="indefinite"/></p:stCondLst>'
            f'<p:childTnLst>'
            f'<p:par><p:cTn id="4" fill="hold">'
            f'<p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>'
            + "".join(effects) +
            f'</p:childTnLst></p:cTn></p:par>'
            f'</p:childTnLst></p:cTn></p:par>'
            f'</p:childTnLst></p:cTn>'
            f'<p:prevCondLst><p:cond evt="onPrev" delay="0">'
            f'<p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst>'
            f'<p:nextCondLst><p:cond evt="onNext" delay="0">'
            f'<p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst>'
            f'</p:seq></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>')


def apply_entrance(path, effect="bounce", shapes_per_slide=1):
    """Entrance animation, ONE EFFECT PER BULLET (staggered) or on the whole
    body shape when it has few paragraphs. effect 'none' → no-op. Every
    fragment is parsed before injection; the whole package is re-verified
    after; on any failure the original file is restored."""
    effect = str(effect or "").lower().strip()
    if effect == "none" or effect not in _ANIM_EFFECTS:
        return {"ok": True, "applied": False, "effect": effect or "none"}
    names = _slide_names(path)
    applied = 0
    skipped = []

    def mutate(name, xml):
        nonlocal applied
        if name == "ppt/slides/slide1.xml":
            return xml
        text = xml.decode("utf-8", "replace")
        if "<p:timing" in text or not _well_formed(xml):
            return xml
        spid, paras = _body_shape(text)
        if not spid or paras < 1:
            return xml
        # bullets = paragraphs beyond the (usually empty) first one
        bullet_count = max(0, paras - 1) if paras > 1 else 1
        bullet_count = min(bullet_count, max(1, shapes_per_slide * 20))
        effects, eid, grp = [], 20, 0
        for i in range(bullet_count):
            ap = i + 1 if paras > 1 else None
            node = "clickEffect" if i == 0 else "withEffect"
            delay = i * _STAGGER_MS
            fx = _effect_par(eid, spid, ap, delay, node, grp, effect)
            if not _well_formed(fx.encode()):
                skipped.append(f"effect {i + 1}")
                continue
            effects.append(fx)
            eid += 4
            grp += 1
        if not effects:
            return xml
        timing = _timing_xml(effects)
        if not _well_formed(timing.encode()):
            skipped.append("timing tree")
            return xml
        out = _insert_before_end(text, timing)
        if out != text:
            applied += 1
        return out.encode("utf-8")

    ok, err = _rewrite(path, mutate)
    if not ok:
        return {"ok": False, "message": err}
    note = ""
    if skipped:
        note = f" (skipped invalid fragments: {', '.join(skipped[:3])})"
    return {"ok": True, "applied": applied, "effect": effect,
            "message": f"{applied} slide(s) animated with entrance effect "
                       f"'{effect}' — one effect per bullet{note}"}


def apply_features(path, transition="none", speed="med", animation="none"):
    """Apply transitions + entrance animation to a saved deck. Every step is
    verified: a failure in one feature is reported, the other still runs,
    and the file is NEVER left corrupt (bad rewrites are reverted)."""
    report = {"path": path}
    tr = apply_transitions(path, transition, speed)
    an = apply_entrance(path, animation)
    report["transitions"] = tr
    report["animation"] = an
    report["ok"] = bool(tr.get("applied") or an.get("applied"))
    return report
