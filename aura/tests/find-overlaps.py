#!/usr/bin/env python3
"""
AURA :: layout overlap detector
-------------------------------
Walks the real rendered DOM and reports pairs of TEXT-BEARING elements whose
bounding boxes intersect while both are in NORMAL FLOW. Deliberately stacked
layers (an element that is itself absolute/fixed, or lives under one inside the
same panel) are skipped — those are supposed to overlap.

CROSS-LAYER CHECK: it also asks, at the centre of every in-flow text box,
"which element is actually on top here?" via elementsFromPoint. If the answer
is an unrelated element that also paints text, two independent layers are
fighting for the same pixels — that is the bug the user reported (the trace log
painting through the transparent VISION panel).

Plus: text spilling out of non-scrolling boxes, and text clipped by overflow.

Usage:  python3 tests/find-overlaps.py [PORT] [--shot]
"""
import sys, pathlib

PORT = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1].isdigit() else "8199"
BASE = f"http://localhost:{PORT}"
SHOT = "--shot" in sys.argv

from playwright.sync_api import sync_playwright

COMMON = r"""
const ownText = (el) => {
  for (const n of el.childNodes)
    if (n.nodeType === 3 && n.textContent.trim().length > 1) return true;
  return false;
};
/**
 * The rect a user can ACTUALLY see: the element's own box intersected with
 * every scrolling/clipping ancestor. getBoundingClientRect() alone reports
 * layout geometry even for content scrolled far out of view, which made a
 * scrolled-away wardrobe swatch look like it overlapped the trace dock.
 * Returns null when the element is entirely clipped away.
 */
const visibleRect = (el) => {
  let r = el.getBoundingClientRect();
  let box = { l: r.left, t: r.top, r: r.right, b: r.bottom };
  for (let n = el.parentElement; n && n !== document.documentElement; n = n.parentElement) {
    const cs = getComputedStyle(n);
    const clips = ['hidden', 'auto', 'scroll', 'clip'];
    if (!clips.includes(cs.overflowX) && !clips.includes(cs.overflowY)) continue;
    const nr = n.getBoundingClientRect();
    if (clips.includes(cs.overflowX)) { box.l = Math.max(box.l, nr.left);  box.r = Math.min(box.r, nr.right); }
    if (clips.includes(cs.overflowY)) { box.t = Math.max(box.t, nr.top);   box.b = Math.min(box.b, nr.bottom); }
    if (box.r - box.l <= 0 || box.b - box.t <= 0) return null;
  }
  box.l = Math.max(box.l, 0); box.t = Math.max(box.t, 0);
  box.r = Math.min(box.r, innerWidth); box.b = Math.min(box.b, innerHeight);
  if (box.r - box.l <= 1 || box.b - box.t <= 1) return null;
  return { left: box.l, top: box.t, right: box.r, bottom: box.b,
           x: box.l, y: box.t, width: box.r - box.l, height: box.b - box.t };
};
const sel = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
  (typeof el.className === 'string' && el.className
    ? '.' + el.className.trim().split(/\s+/).slice(0,2).join('.') : '');
const path = (el) => {
  const bits = []; let n = el;
  for (let i = 0; n && n !== document.body && i < 4; i++, n = n.parentElement) bits.unshift(sel(n));
  return bits.join(' > ');
};
/**
 * Do two elements REALLY share pixels?
 *
 * getBoundingClientRect() returns one union box for an inline element that
 * wraps across lines, and that box covers the empty gutter at the start of the
 * first line — where a badge or bullet legitimately sits. Comparing every
 * individual line box (getClientRects) instead removes that whole class of
 * false positive. Verified against a real case on /dev where a wrapped <code>
 * appeared to collide with a "fix" badge it never touches.
 */
const reallyOverlaps = (elA, elB) => {
  const A = [...elA.getClientRects()], B = [...elB.getClientRects()];
  if (!A.length || !B.length) return false;
  for (const a of A) for (const b of B) {
    const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (ox > 1.5 && oy > 1.5) return true;
  }
  return false;
};
const vis = (el) => {
  const cs = getComputedStyle(el), r = el.getBoundingClientRect();
  return r.width > 1 && r.height > 1 && cs.display !== 'none' &&
         cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0.02;
};
"""

JS = r"""
() => {
""" + COMMON + r"""
  const out = [];
  const ROOT = (el) => el.closest('.panel, .modal, .cc-scroll, body');
  const stacked = (el) => {
    const stop = ROOT(el); let n = el;
    while (n && n !== stop && n !== document.body) {
      const cs = getComputedStyle(n);
      if (['absolute','fixed','sticky'].includes(cs.position)) return true;
      if (cs.float !== 'none') return true;
      if (parseFloat(cs.marginTop) < -2 || parseFloat(cs.marginBottom) < -2) return true;
      n = n.parentElement;
    }
    return false;
  };
  const cands = [...document.querySelectorAll('body *')]
    .filter(vis).filter(ownText).filter(e => !stacked(e))
    .map(el => ({ el, r: visibleRect(el) }))
    .filter(o => o.r);
  for (let i = 0; i < cands.length; i++) for (let j = i + 1; j < cands.length; j++) {
    const a = cands[i], b = cands[j];
    if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
    // Same rule as the cross-layer pass: a modal legitimately covers the page.
    const layer = (n) => n.closest('.setup, .modal, .cmdp, .toast, #boot') || null;
    if (layer(a.el) !== layer(b.el)) continue;
    const ox = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
    const oy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
    // An inline element that WRAPS returns one union box from
    // getBoundingClientRect() covering both lines — including the gap at the
    // start of line 1, where an unrelated badge legitimately sits. Confirm
    // against the individual line boxes before calling it an overlap.
    if (ox > 1.5 && oy > 1.5 && !reallyOverlaps(a.el, b.el)) continue;
    if (ox > 1.5 && oy > 1.5) out.push({ ox: ox|0, oy: oy|0, area: (ox*oy)|0,
      a: path(a.el), b: path(b.el),
      aText: a.el.textContent.trim().slice(0,44), bText: b.el.textContent.trim().slice(0,44),
      aRect: [a.r.x|0,a.r.y|0,a.r.width|0,a.r.height|0],
      bRect: [b.r.x|0,b.r.y|0,b.r.width|0,b.r.height|0] });
  }
  out.sort((x,y) => y.area - x.area);
  return out.slice(0, 30);
}
"""

# Two unrelated text layers occupying the same pixel.
CROSS_JS = r"""
() => {
""" + COMMON + r"""
  const seen = new Set(), out = [];
  const texts = [...document.querySelectorAll('body *')].filter(vis).filter(ownText);
  for (const el of texts) {
    const r = visibleRect(el);
    if (!r) continue;   // scrolled out of sight — cannot collide with anything
    const px = r.left + Math.min(r.width / 2, 60), py = r.top + r.height / 2;
    if (px < 0 || py < 0 || px > innerWidth || py > innerHeight) continue;
    const stack = document.elementsFromPoint(px, py);
    const mine = stack.indexOf(el);
    if (mine < 0) continue;
    // Anything painted ABOVE me at my own centre that is not my ancestor.
    for (let k = 0; k < mine; k++) {
      const o = stack[k];
      if (o.contains(el) || el.contains(o)) continue;
      if (!ownText(o)) continue;
      // Same wrapped-inline guard as the pairwise pass.
      if (!reallyOverlaps(o, el)) continue;
      // A MODAL is supposed to paint over the page behind it. Only flag a
      // collision when both layers are in the same overlay context — otherwise
      // every open dialog reports dozens of meaningless "overlaps".
      const layer = (n) => n.closest('.setup, .modal, .cmdp, .toast, #boot') || null;
      if (layer(o) !== layer(el)) continue;
      const key = sel(o) + '|' + sel(el);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ over: path(o), under: path(el),
                 overText: o.textContent.trim().slice(0,40),
                 underText: el.textContent.trim().slice(0,40) });
      break;
    }
  }
  return out.slice(0, 25);
}
"""

CLIP_JS = r"""
() => {
""" + COMMON + r"""
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const over = el.scrollWidth - el.clientWidth;
    if (over > 2 && !['auto','scroll','hidden'].includes(cs.overflowX))
      out.push({ kind:'hspill', by: over, sel: sel(el), text: el.textContent.trim().slice(0,40) });
    // A clipped box only matters when it hides TEXT. Purely decorative
    // children (an animated scan bar translated past the bottom edge) inflate
    // scrollHeight without hiding anything a user needs to read.
    const vover = el.scrollHeight - el.clientHeight;
    if (vover > 4 && cs.overflowY === 'hidden') {
      const br = el.getBoundingClientRect();
      let cutText = null;
      for (const t of el.querySelectorAll('*')) {
        if (!ownText(t)) continue;
        const tr = t.getBoundingClientRect();
        if (tr.bottom > br.bottom + 1 || tr.top < br.top - 1) { cutText = t; break; }
      }
      if (cutText)
        out.push({ kind:'vclip', by: vover, sel: sel(el),
                   text: cutText.textContent.trim().slice(0,40) });
    }
  }
  return out.slice(0, 25);
}
"""

VIEWPORTS = [("1440x900", 1440, 900), ("1280x800", 1280, 800), ("1920x1080", 1920, 1080)]
PANELS = ["chat", "vision", "devconsole", "ops", "wardrobe", "gestures"]

FIRE_TRACE = """async () => {
  const { bus } = await import('/js/core/bus.js');
  bus.emit('trace:start', { id: 'ov1', title: 'Camera \\u00b7 enable' });
  bus.emit('trace:step', { id: 'ov1', label: 'getUserMedia', state: 'ok', ms: 214 });
  bus.emit('trace:step', { id: 'ov1', label: 'FaceLandmarker load', state: 'ok', ms: 890 });
  bus.emit('trace:start', { id: 'ov2', title: 'Vision \\u00b7 describe frame' });
  bus.emit('trace:step', { id: 'ov2', label: 'capture 1280x720', state: 'ok', ms: 31 });
}"""

REVEAL_VISION = """() => {
  const show = (id, txt) => { const e = document.getElementById(id);
    if (!e) return; e.hidden = false; if (txt) e.textContent = txt; };
  show('pg-live');
  show('pg-veto', 'Held back: only enrolled people are in frame.');
  show('pg-perm', 'Privacy Guard needs the Minimize Active Window permission.');
  show('cam-error', 'NotAllowedError: camera permission was denied by the browser.');
}"""


def open_app(pg, url="/"):
    pg.goto(BASE + url, wait_until="load")
    if url == "/":
        try:
            pg.wait_for_selector("#boot-enter:not([hidden])", timeout=25000)
            pg.click("#boot-enter")
        except Exception:
            pg.evaluate("() => document.getElementById('app')?.removeAttribute('hidden')")
    pg.wait_for_timeout(1500)
    pg.evaluate("() => { for (const id of ['setup','settings','guide']) "
                "document.getElementById(id)?.setAttribute('hidden',''); }")


def scan(pg, tag, total, shots=None):
    res, cross, spill = pg.evaluate(JS), pg.evaluate(CROSS_JS), pg.evaluate(CLIP_JS)
    if res or cross or spill:
        print(f"\n── {tag} ─────────────────────────")
    for r in res:
        total[0] += 1
        print(f"  OVERLAP {r['ox']}x{r['oy']}px")
        print(f"     A {r['a']}  {r['aRect']}  \u201c{r['aText']}\u201d")
        print(f"     B {r['b']}  {r['bRect']}  \u201c{r['bText']}\u201d")
    for c in cross:
        total[0] += 1
        print(f"  CROSS-LAYER  \u201c{c['overText']}\u201d  paints over  \u201c{c['underText']}\u201d")
        print(f"     over  {c['over']}")
        print(f"     under {c['under']}")
    for s in spill:
        total[0] += 1
        print(f"  {s['kind'].upper():7s} {s['sel']} by {s['by']}px  \u201c{s['text']}\u201d")
    return total


def run():
    out = pathlib.Path("screenshots/overlap"); out.mkdir(parents=True, exist_ok=True)
    total = [0]
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--use-gl=swiftshader"])
        for name, w, h in VIEWPORTS:
            pg = b.new_page(viewport={"width": w, "height": h})
            errs = []
            pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
            open_app(pg)
            for trace_on in (False, True):
                if trace_on:
                    pg.evaluate(FIRE_TRACE); pg.wait_for_timeout(400)
                for panel in PANELS:
                    pg.evaluate(f"""() => {{
                      document.querySelectorAll('.panel').forEach(s => s.classList.remove('active'));
                      document.querySelector('[data-panel="{panel}"].panel')?.classList.add('active');
                    }}""")
                    if panel == "vision":
                        pg.evaluate(REVEAL_VISION)
                    pg.wait_for_timeout(260)
                    scan(pg, f"{name} \u00b7 {panel}{' \u00b7 TRACE RUNNING' if trace_on else ''}", total)
                    if SHOT and trace_on and panel in ("vision", "ops"):
                        pg.screenshot(path=str(out / f"{name}-{panel}-trace.png"))
            if errs:
                print(f"\n  console errors @{name}: {errs[:5]}")
            pg.close()

        # Standalone pages get the same treatment.
        for page, url in (("live", "/screen"), ("dev", "/dev"), ("phone", "/phone")):
            pg = b.new_page(viewport={"width": 1440, "height": 900})
            errs = []
            pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
            open_app(pg, url)
            scan(pg, f"page {page}", total)
            if errs:
                print(f"\n  console errors @{page}: {errs[:4]}")
            pg.close()
        b.close()
    print(f"\n=== {total[0]} layout issue(s) reported ===")
    return total[0]


if __name__ == "__main__":
    run()
    sys.exit(0)
