# CHEATSHEET — commands + quick file map

## Run it

```bash
cd aura
/tmp/pw2/bin/python server/serve.py 8001 --allow-actions --allow-lan
#         port ^^^^                               ^^^^^^^^^^^^^^^^^^ LAN + actions
```

Pages: `/` `/screen` `/phone` `/db` `/dev` `/dev/image-test.html` `/controls`

Phone (terminal, hardcoded — no AI involved): `/phone devices`, `/phone apps`,
`/phone battery`, `/phone caps`, `/phone open phone youtube`, `/phone notify phone …`,
`/phone vibrate phone 400`, `/phone ping phone`, `/phone pair`, `/phone unpair …`

## Reset everything (after any demo toggle)

```bash
curl -X POST -H 'Content-Type: application/json' -d '{}' \
  http://127.0.0.1:8001/api/db/flags/reset
```

## Test (fast, green-record set)

```bash
cd aura
python3 tests/test-controls.py
python3 tests/test-usage.py
python3 tests/test-terminal-cli.py
/tmp/pw2/bin/python tests/test-features.py
/tmp/pw2/bin/python tests/test-docgen.py
node tests/test-controls.mjs
node tests/test-feature-registry.mjs
node tests/test-feature-apps.mjs
node tests/test-doc-agent.mjs
node --experimental-vm-modules tests/test-module-parse.mjs
```

## Quick file map

| Thing | Path |
|-------|------|
| Server + router + REPL | `aura/server/serve.py` |
| Action dispatcher | `aura/server/bridge.py` (`dispatch`, `_resolve_path`) |
| DB / vault / flags API | `aura/persistence/api.py` |
| Master Controls registry | `aura/persistence/feature_flags.py` |
| DB + migrations | `aura/persistence/db.py`, `migrations/` |
| Repositories (typed accessors) | `aura/persistence/repositories/*` |
| Browser bridge client | `aura/js/actions/local-actions.js` |
| Shell controller | `aura/js/main.js` |
| Feature launcher | `aura/js/features/launcher.js` |
| Feature manifest (browser) | `aura/js/features/registry.js` |
| Feature manifest (Python) | `aura/services/manifest.json` + `services/registry.py` |
| Intent parser | `aura/js/features/intent.js` |
| Flags client (browser) | `aura/js/features/controls.js` |
| Docgen service (canonical) | `aura/services/docgen/service.py` (`generate`) |
| Builders (OOXML) | `aura/services/docgen/builder.py` |
| Outline prompts/validate | `aura/services/docgen/outline.py` |
| Visual Resolution Engine | `aura/services/docgen/visuals.py` |
| AI image generation | `aura/services/docgen/images.py` (`generate`) |
| Search adapters | `aura/services/docgen/image_sources.py` |
| Animations/transitions | `aura/services/docgen/animations.py` |
| Browser outline agent | `aura/js/ai/doc-agent.js` |
| AI engine (tool calls/services) | `aura/js/ai/engine.js` |
| Settings tabs markup | `aura/index.html` (`data-tab`, `data-flag`) |
| Dock nav markup | `aura/index.html` (`nav.dock`) |

## Key env vars

| Var | Effect |
|-----|--------|
| `AURA_DB_PATH` | SQLite path override (tests use this!) |
| `AURA_OLLAMA` | Ollama base URL (default `http://localhost:11434`) |

## Feature flags quick reference

- Add: `persistence/feature_flags.py` → `FLAG_DEFS` + gate at choke point +
  `data-flag`/`isOn` + tests.
- Protected: `page.controls`, `panel.chat` (API refuses).
- Gate helper (server): `serve._feature_on(id)` (fail-open).
- Gate helper (browser): `await isOn(id)` / `applyFlagVisibility()`.
- Pipeline off payload: `{ok:false, disabled:true, code:'feature_off', message}`.
