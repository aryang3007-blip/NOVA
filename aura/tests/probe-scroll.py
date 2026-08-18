#!/usr/bin/env python3
"""Measure which flex children overflow their panel once the trace dock is tall."""
import sys
PORT = sys.argv[1] if len(sys.argv) > 1 else "8199"
BASE = f"http://localhost:{PORT}"
from playwright.sync_api import sync_playwright

PROBE = """() => {
  const out = [];
  const stack = document.querySelector('.panel-stack');
  const dock = document.getElementById('trace-dock');
  const sr = stack.getBoundingClientRect(), dr = dock.getBoundingClientRect();
  for (const p of document.querySelectorAll('.panel')) {
    const was = p.classList.contains('active');
    p.classList.add('active');
    const pr = p.getBoundingClientRect();
    for (const c of p.children) {
      const cr = c.getBoundingClientRect(), cs = getComputedStyle(c);
      if (cr.bottom > pr.bottom + 1)
        out.push({ panel: p.dataset.panel,
          child: c.tagName.toLowerCase() + '.' + (c.className||'').split(' ')[0],
          childH: cr.height|0, panelH: pr.height|0, overBy: (cr.bottom - pr.bottom)|0,
          flex: cs.flex, minH: cs.minHeight, overflowY: cs.overflowY });
    }
    if (!was) p.classList.remove('active');
  }
  return { stack: [sr.y|0, sr.height|0], dock: [dr.y|0, dr.height|0],
           dockHidden: dock.hidden, rows: out };
}"""

BOX = """() => {
  const b = document.querySelector('.screenbox');
  const br = b.getBoundingClientRect();
  // Which TEXT is actually cut off by the box?
  const cut = [];
  for (const el of b.querySelectorAll('*')) {
    let own = false;
    for (const n of el.childNodes)
      if (n.nodeType === 3 && n.textContent.trim().length > 1) own = true;
    if (!own) continue;
    const r = el.getBoundingClientRect();
    if (r.bottom > br.bottom + 1 || r.top < br.top - 1)
      cut.push({ t: el.textContent.trim().slice(0,34), bottom: (r.bottom-br.bottom)|0 });
  }
  return { boxH: br.height|0, clientH: b.clientHeight, scrollH: b.scrollHeight, cutText: cut };
}"""


def main():
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--use-gl=swiftshader"])
        pg = b.new_page(viewport={"width": 1920, "height": 1080})
        pg.goto(BASE + "/", wait_until="load")
        pg.wait_for_selector("#boot-enter:not([hidden])", timeout=25000)
        pg.click("#boot-enter"); pg.wait_for_timeout(1500)
        # six traces with many steps -> dock hits its 42% cap
        pg.evaluate("""async () => {
          const { bus } = await import('/js/core/bus.js');
          for (let i = 0; i < 6; i++) {
            bus.emit('trace:start', { id: 't'+i, title: 'Camera \\u00b7 job ' + i });
            for (let k = 0; k < 4; k++)
              bus.emit('trace:step', { id: 't'+i, label: 'step ' + k, state: 'ok', ms: 100+k });
          }
        }""")
        pg.wait_for_timeout(500)
        r = pg.evaluate(PROBE)
        print(f"  panel-stack y/h = {r['stack']}   trace-dock y/h = {r['dock']}  hidden={r['dockHidden']}")
        print("── panel children overflowing their panel ──")
        if not r["rows"]:
            print("  (none)")
        for x in r["rows"]:
            print(f"  {x['panel']:<12} {x['child']:<22} h={x['childH']:<5} panel={x['panelH']:<5} "
                  f"over={x['overBy']:<4} flex={x['flex']:<12} minH={x['minH']:<6} ovY={x['overflowY']}")
        pg.close()

        pg = b.new_page(viewport={"width": 1440, "height": 900})
        pg.goto(BASE + "/screen", wait_until="load"); pg.wait_for_timeout(2500)
        r = pg.evaluate(BOX)
        print(f"\n── /screen .screenbox  h={r['boxH']} clientH={r['clientH']} scrollH={r['scrollH']}")
        print(f"   text actually cut off: {r['cutText'] or '(none — scrollH is the decorative .scan bar)'}")
        pg.close(); b.close()


if __name__ == "__main__":
    main()
