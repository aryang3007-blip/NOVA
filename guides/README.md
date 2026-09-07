# NOVA / AURA — Working Guides

The practical handbook for working on this project yourself. Written from the
code as of commit **`26c5d70`** (Master Controls added). Everything here was
verified against the repo — file paths, function names, routes, flags.

## Start here

| # | Guide | What it answers |
|---|-------|-----------------|
| 01 | [PAGES-MAP](01-PAGES-MAP.md) | Every page/URL in the app, what it does, which file, which control flag |
| 02 | [QUICKSTART](02-QUICKSTART.md) | How to launch, flags, requirements, terminal commands |
| 03 | [ARCHITECTURE](03-ARCHITECTURE.md) | How the whole thing fits together (layers, boot order, data flow) |
| 04 | [SERVER-BRIDGE-API](04-SERVER-BRIDGE-API.md) | serve.py routes, GET/POST APIs, bridge actions, permissions |
| 05 | [PERSISTENCE-DB-VAULT](05-PERSISTENCE-DB-VAULT.md) | SQLite DB, config, vault keys, budget/usage, backup/restore, /db page |
| 06 | [DOCGEN-PIPELINE](06-DOCGEN-PIPELINE.md) | PPT/Word/Excel generation: outline → build → visuals → animation |
| 07 | [IMAGES-VRE](07-IMAGES-VRE.md) | Image providers, images-only keys, budget/pacing, Visual Resolution Engine |
| 08 | [FEATURES-APPS](08-FEATURES-APPS.md) | Feature manifest, launcher, intents, how apps mount |
| 09 | [MASTER-CONTROLS](09-MASTER-CONTROLS.md) | 35 flags, how to add one, the safety rules (never brick) |
| 10 | [FRONTEND-MAP](10-FRONTEND-MAP.md) | index.html structure, main.js centres of gravity, settings tabs, panels |
| 11 | [TESTING](11-TESTING.md) | Every suite, how to run it, the Python venv gotcha |
| 12 | [CONVENTIONS-PITFALLS](12-CONVENTIONS-PITFALLS.md) | The rules this project lives by + traps that already bit us |
| — | [CHEATSHEET](CHEATSHEET.md) | One-page commands + quick file map |

## Repository layout (top level)

```
NOVA/
├── guides/            # ← you are here
├── aura/              # the actual app
│   ├── index.html     # main shell (chat/avatar/settings)
│   ├── live.html      # /screen AURA Live
│   ├── phone.html     # /phone companion
│   ├── db.html        # /db database manager
│   ├── controls.html  # /controls Master Controls
│   ├── dev.html       # /dev version page
│   ├── dev/           # temporary dev surfaces (image-test.html)
│   ├── serve.py       # HTTP server + terminal REPL (canonical entry)
│   ├── server/        # bridge, devices, organizer, websearch, automation…
│   ├── persistence/   # SQLite DB, vault, repositories, feature flags
│   ├── services/      # docgen pipeline, registry/manifest
│   ├── js/            # browser app (ES modules, no build step)
│   ├── apps/          # feature popup apps (ppt-builder, doc-builder, research)
│   ├── css/           # styles
│   ├── tests/         # all test suites
│   └── docs/          # pre-existing design docs (partly outdated; guides win)
└── (repo root files like .gitignore)
```

**The single most important file: `aura/server/serve.py`** — it *is* the
server, the router, the CLI and the terminal REPL in one file.

## Golden rules (full list in guide 12)

1. **Everything defaults ON.** A control toggle can turn things off; it can
   never break boot or hide the app permanently.
2. **Honest over pretending.** If a capability is missing/off/failed, say so.
   Never fake a file, an image, a model, or a success.
3. **AI writes content, never paths.** The model returns an outline; Python
   renders it. One path resolver (`bridge._resolve_path`) is the only jail.
4. **Budget before wire.** Spend checks run before any network call.
5. **No build step.** Vanilla ES modules + Python stdlib. Don't introduce npm
   unless you have a very good reason.
