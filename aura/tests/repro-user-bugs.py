#!/usr/bin/env python3
"""
Reproduce the four bugs reported after the v0.20 Windows test.

  2. No Settings -> Devices section, so the pairing code is unreachable in the UI.
  3. Opening a long settings tab scrolls the tab strip out of view.
  4. (simulated separately) mic restart storm.

Usage: python3 tests/repro-user-bugs.py [PORT]
"""
import sys
PORT = sys.argv[1] if len(sys.argv) > 1 else "8221"
BASE = f"http://localhost:{PORT}"
from playwright.sync_api import sync_playwright


def main():
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--use-gl=swiftshader", "--no-sandbox"])
        pg = b.new_page(viewport={"width": 1440, "height": 900})
        pg.goto(BASE + "/", wait_until="load")
        pg.wait_for_selector("#boot-enter:not([hidden])", timeout=40000)
        pg.click("#boot-enter")
        pg.wait_for_timeout(1800)
        pg.evaluate("() => document.querySelectorAll('.setup').forEach(e => e.remove())")

        print("\n\u2500\u2500 BUG 2 \u00b7 is there any Devices UI in Settings? \u2500\u2500")
        r2 = pg.evaluate("""() => {
          const tabs = [...document.querySelectorAll('#settings .tab')]
              .map(t => t.dataset.tab);
          const txt = document.getElementById('settings').innerText.toLowerCase();
          return { tabs,
                   hasDevicesTab: tabs.includes('devices'),
                   mentionsPairing: txt.includes('pair'),
                   mentionsPhone: txt.includes('phone'),
                   pairButton: !!document.querySelector('#settings [id*="pair"], #settings [id*="device"]') };
        }""")
        print(f"  settings tabs      : {r2['tabs']}")
        print(f"  has a Devices tab  : {r2['hasDevicesTab']}")
        print(f"  mentions 'pair'    : {r2['mentionsPairing']}")
        print(f"  any pair/device el : {r2['pairButton']}")
        print("  -> the ONLY way to pair is the /devices chat command."
              if not r2["hasDevicesTab"] else "")

        print("\n\u2500\u2500 BUG 3 \u00b7 does the tab strip scroll away? \u2500\u2500")
        pg.evaluate("() => window.AURA.openSettings()")
        pg.wait_for_timeout(500)
        for tab in ["ai", "desktop", "appearance", "about"]:
            r3 = pg.evaluate(f"""() => {{
              document.querySelector('#settings .tab[data-tab="{tab}"]')?.click();
              return null;
            }}""")
            pg.wait_for_timeout(250)
            # scroll the modal to the bottom, as a user reading a long tab does
            m = pg.evaluate("""() => {
              const box  = document.querySelector('#settings .modal-box');
              const body = document.querySelector('#settings .modal-body');
              const tabs = document.querySelector('#settings .tabs');
              body.scrollTop = body.scrollHeight;
              return { boxScroll: box.scrollTop, boxScrollH: box.scrollHeight,
                       boxClientH: box.clientHeight,
                       bodyScrollH: body.scrollHeight, bodyClientH: body.clientHeight };
            }""")
            pg.wait_for_timeout(200)
            vis = pg.evaluate("""() => {
              const tabs = document.querySelector('#settings .tabs');
              const box  = document.querySelector('#settings .modal-box');
              const tr = tabs.getBoundingClientRect(), br = box.getBoundingClientRect();
              const visible = Math.max(0, Math.min(tr.bottom, br.bottom) - Math.max(tr.top, br.top));
              return { tabH: Math.round(tr.height), visible: Math.round(visible),
                       tabTop: Math.round(tr.top), boxTop: Math.round(br.top) };
            }""")
            state = "OK" if vis["visible"] >= vis["tabH"] - 1 else "CLIPPED"
            print(f"  {tab:<11} boxScroll={m['boxScroll']:>4}  "
                  f"tabs {vis['visible']}/{vis['tabH']}px visible   {state}")

        b.close()


if __name__ == "__main__":
    main()
