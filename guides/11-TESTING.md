# 11 · TESTING — every suite and how to run it

## The Python venv gotcha (important!)

`system python3` in this sandbox does **not** have `python-pptx`, `openpyxl`,
`python-docx`, `lxml`, `pillow`, `xmlschema`, `ddgs`. The docgen suite will
report "missing library" style failures under system python. Use the venv:

```bash
# recreate if missing (sandbox can wipe it)
python3 -m venv /tmp/pw2
/tmp/pw2/bin/pip install python-pptx lxml python-docx openpyxl pillow xmlschema ddgs

cd aura
/tmp/pw2/bin/python tests/test-docgen.py    # 89/89
/tmp/pw2/bin/python tests/test-features.py  # 131/131
```

Most pure-python suites (usage, controls, terminal-cli) run fine under
`python3` too, but using `/tmp/pw2/bin/python` everywhere is safer.

## The suites (as of 26c5d70)

| Suite | Command | Count |
|-------|---------|-------|
| Master Controls (Python) | `python3 tests/test-controls.py` | 35 |
| Master Controls (client) | `node tests/test-controls.mjs` | 12 |
| Usage/budget/DB API | `python3 tests/test-usage.py` | 24 |
| Docgen pipeline | `/tmp/pw2/bin/python tests/test-docgen.py` | 89 |
| Features (manifest/images/VRE/db-page) | `/tmp/pw2/bin/python tests/test-features.py` | 131 |
| Terminal CLI | `/tmp/pw2/bin/python tests/test-terminal-cli.py` | 89 |
| Feature registry | `node tests/test-feature-registry.mjs` | 23 |
| Feature apps/intents | `node tests/test-feature-apps.mjs` | 33 |
| Doc agent (outline) | `node tests/test-doc-agent.mjs` | 98 |
| Module parse (ESM + inline scripts) | `node --experimental-vm-modules tests/test-module-parse.mjs` | 114 |

Other (broader, some need playwright — not installed in this sandbox):
`test-bridge-security.py`, `test-server-resilience.py`,
`test-server-concurrency.py`, `test-search-automation.py`,
`test-overlay-vdesk.py`, `test-capabilities.py`, `test-ollama-live.py`,
plus the `tests/*.mjs` unit set and browser suites listed in
`tests/run-all.sh`.

## Typical focused runs

```bash
cd aura

# one suite
python3 tests/test-controls.py

# the session's "green record" set (fast, no browser)
for t in test-controls test-usage test-terminal-cli; do python3 tests/$t.py; done
/tmp/pw2/bin/python tests/test-features.py
/tmp/pw2/bin/python tests/test-docgen.py
node tests/test-controls.mjs
node tests/test-feature-registry.mjs
node tests/test-feature-apps.mjs
node tests/test-doc-agent.mjs
node --experimental-vm-modules tests/test-module-parse.mjs

# everything (starts its own server; browser suites need playwright)
bash tests/run-all.sh
```

## Test conventions

- Most Python suites print `PASS n  FAIL m` and `sys.exit(1)` on failure.
- Browser suites (`*.mjs`) print `PASS n / FAIL m` and exit non-zero.
- **Isolation:** suites that touch the spend ledger set `AURA_DB_PATH` to a
  temp DB **before importing persistence** (see `test-usage.py`,
  `test-features.py`, `test-controls.py`). Never let a test pollute
  `~/.aura/aura.db`.
- **The live server is stateful.** The current flag store lives in the real
  DB. After toggling for a demo/test, press RESET ALL or call
  `POST /api/db/flags/reset` — otherwise the next run starts with features
  off.
- `test-features.py` also checks "page presence" (file exists + safe API
  usage, no raw SQL) — add your page there.
- `test-module-parse.mjs` now parses `index.html`, `dev.html`, `live.html`,
  `phone.html`, `db.html`, `controls.html` inline scripts. Add new pages to
  that list.

## Live smoke (no browser in this sandbox)

```bash
cd aura && /tmp/pw2/bin/python server/serve.py 8001 --allow-actions --allow-lan
# in another shell:
for p in / /db /controls /screen /dev /dev/image-test.html; do
  echo -n "$p "; curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8001$p
done
curl -s http://127.0.0.1:8001/api/db/flags | python3 -m json.tool | head -20
```

Network note: this sandbox has **no external internet** (only PyPI). Live
search/AI calls can't be smoke-tested here; use fakes and the injected
`urlopen_fn` seams (that's exactly why `images.generate()` takes
`key_fn`/`urlopen_fn`/`sleep_fn`).
