#!/usr/bin/env python3
"""
Reproduce the reported bug: "in the vision sidebar the privacy guard text
overlaps the logs for the camera actions".

Hypothesis: #trace-log is an in-flow child of <aside class="panels">, while
every .panel is position:absolute; inset:0 with NO background. When a trace is
running the log paints in normal flow and the transparent active panel is drawn
straight over the top of it. Both sets of text land on the same pixels.

Usage: python3 tests/repro-trace-overlap.py [PORT]
"""
import sys, pathlib
PORT = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1].isdigit() else "8199"
BASE = f"http://localhost:{PORT}"
from playwright.sync_api import sync_playwright

FIRE = """async () => {
  // Real trace events, exactly as vision/camera work emits them. ES modules are
  // singletons per origin, so this is the very same bus main.js wired up.
  const { bus } = await import('/js/core/bus.js');
  if (!bus) return 'NO BUS';
  bus.emit('trace:start', { id: 't1', title: 'Camera · enable' });
  bus.emit('trace:step', { id: 't1', label: 'getUserMedia', state: 'ok', ms: 214 });
  bus.emit('trace:step', { id: 't1', label: 'FaceLandmarker load', state: 'ok', ms: 890 });
  bus.emit('trace:step', { id: 't1', label: 'HandLandmarker load', state: 'ok', ms: 654 });
  bus.emit('trace:start', { id: 't2', title: 'Vision · describe frame' });
  bus.emit('trace:step', { id: 't2', label: 'capture 1280x720', state: 'ok', ms: 31 });
  bus.emit('trace:step', { id: 't2', label: 'qwen2.5vl:7b', state: 'run', ms: 4120 });
  return 'fired';
}"""

MEASURE = """() => {
  const log = document.getElementById('trace-log');
  const panel = document.querySelector('.panel.active');
  if (!log || !panel) return { err: 'missing' };
  const lr = log.getBoundingClientRect();
  const cs = getComputedStyle(log);
  const pcs = getComputedStyle(panel);

  // Which text does the log actually collide with?
  const hits = [];
  for (const el of panel.querySelectorAll('*')) {
    let own = false;
    for (const n of el.childNodes)
      if (n.nodeType === 3 && n.textContent.trim().length > 1) own = true;
    if (!own) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const ox = Math.min(lr.right, r.right) - Math.max(lr.left, r.left);
    const oy = Math.min(lr.bottom, r.bottom) - Math.max(lr.top, r.top);
    if (ox > 1 && oy > 1)
      hits.push({ t: el.textContent.trim().slice(0, 48), ox: ox|0, oy: oy|0 });
  }

  // The decisive check: at a point inside the trace log, who is on top?
  const px = lr.left + 40, py = lr.top + 24;
  const top = document.elementFromPoint(px, py);
  const stack = document.elementsFromPoint(px, py).slice(0, 5)
      .map(e => e.tagName.toLowerCase() + (e.id ? '#'+e.id : '') +
                (typeof e.className === 'string' && e.className ?
                  '.' + e.className.trim().split(/\\s+/)[0] : ''));

  return {
    logHidden: log.hidden,
    logRect: [lr.x|0, lr.y|0, lr.width|0, lr.height|0],
    logPos: cs.position, logBg: cs.backgroundColor, logZ: cs.zIndex,
    panelPos: pcs.position, panelBg: pcs.backgroundColor,
    panelName: panel.dataset.panel,
    hits: hits.slice(0, 12), hitCount: hits.length,
    topAtLogPoint: top ? top.tagName.toLowerCase() + (top.id ? '#'+top.id : '') +
        (typeof top.className === 'string' && top.className ?
          '.' + top.className.trim().split(/\\s+/)[0] : '') : null,
    stack,
  };
}"""


def main():
    out = pathlib.Path("screenshots/overlap"); out.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--use-gl=swiftshader"])
        pg = b.new_page(viewport={"width": 1440, "height": 900})
        pg.goto(BASE + "/", wait_until="load")
        pg.wait_for_selector("#boot-enter:not([hidden])", timeout=25000)
        pg.click("#boot-enter")
        pg.wait_for_timeout(1500)
        pg.evaluate("() => { for (const id of ['setup','settings','guide']) "
                    "document.getElementById(id)?.setAttribute('hidden',''); }")
        # switch to VISION, reveal the Privacy Guard live block
        pg.evaluate("""() => {
          document.querySelectorAll('.panel').forEach(s => s.classList.remove('active'));
          document.querySelector('[data-panel="vision"].panel')?.classList.add('active');
          const l = document.getElementById('pg-live'); if (l) l.hidden = false;
        }""")
        print("fire:", pg.evaluate(FIRE))
        pg.wait_for_timeout(500)
        r = pg.evaluate(MEASURE)
        for k, v in r.items():
            if k != "hits":
                print(f"  {k:16s} {v}")
        print("  colliding text in the VISION panel:")
        for h in r.get("hits", []):
            print(f"     {h['ox']:4d}x{h['oy']:<4d} \u201c{h['t']}\u201d")
        pg.screenshot(path=str(out / "repro-trace-overlap.png"))
        print(f"\n  screenshot -> screenshots/overlap/repro-trace-overlap.png")
        b.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
