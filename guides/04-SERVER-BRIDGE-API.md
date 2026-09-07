# 04 · SERVER, BRIDGE & API

Everything HTTP lives in `aura/server/serve.py`. The router is the
`Handler` class (`http.server.SimpleHTTPRequestHandler` subclass):
`do_GET` (line ~251), `do_POST` (~601), `do_DELETE` (~796).

## GET routes (summary)

| Path | Auth | Purpose |
|------|------|---------|
| `/` `/screen` `/phone` `/db` `/dev` `/controls` | — | Pages (see guide 01) |
| `/dev/*` (static) | — | Dev surfaces, Master-Controls-gated |
| `/api/db/...` | — | SQLite/vault/flags domain API (see guide 05) |
| `/api/status` | — | Runtime status, DB info, vault, actionsEnabled, OS |
| `/api/health` | — | Subsystem health incl. docgen availability |
| `/api/version` | — | VERSION.json |
| `/api/token` | — | One-time bridge token (only when `--allow-actions`) |
| `/api/metrics` | — | Uptime + counters |
| `/api/apps` | X-AURA-Token | Installed apps (`bridge.list_apps`) |
| `/api/devices` | X-AURA-Token | Paired device status |
| `/api/voice/status`, `/api/voice/devices` | — | Speech status |
| `/api/voice/events` | — | Long-poll voice/wake event stream |
| `/api/ollama/status`, `/api/ollama/catalog` | — | Ollama health + models |
| `/api/fetch` | — | Proxied fetch for the browser (same-origin guard) |

## POST routes

| Path | Notes |
|------|-------|
| `/api/db/...` | Persistence domain API (settings, usage, memory, vault, flags…) |
| `/api/action` | **The bridge.** Requires `--allow-actions` + `X-AURA-Token`, body `{action, params}` (≤3 MB) |
| `/api/voice/status`, `/api/voice/wake` | Speech control |
| `/api/device/*`, `/api/devices/*` | Companion pairing/ack (host token) |
| `/api/ollama/*` | `chat`, `generate`, `pull`, `embed`, `models` — proxied with model resolution + `X-AURA-Model-Note` header when a model is substituted |

## The Action Bridge (`server/bridge.py`)

`dispatch(action, params)` is the single dispatcher
(`aura/server/bridge.py` ~line 1139). **All** desktop/document/web actions
flow through it.

### Action namespaces

| Prefix / names | Module behind it |
|----------------|------------------|
| `open_app`, `open_url`, `search`, `media`, `volume`, `screenshot`, `list_apps`, `running_apps`, `system_info`, `list_directory`, `read_file`, `write_file`, `open_folder`, `run_command`, `inspect_command`, `open_terminal`, `get_policy`, `set_policy`, `detect_apps`, `clipboard_read`, `clipboard_write`, `window_action` | bridge internals + `server/windows_mgr.py` |
| `overlay_*`, `vdesk_*`, `device_*`, `window_*` | `overlay.py`, `vdesk.py`, `devices.py` |
| `device_command` / `device_apps` | canonical `devices.command(sub, arg)` — the ONE implementation behind chat `/devices …`, terminal `/phone …` and this action |
| `doc_capabilities`, `doc_build` (`doc_*`) | `services/docgen/service.py` |
| `image_test` | dev harness → `services/docgen/images.generate` directly |
| `web_capabilities`, `web_search`, `web_research`, `read_page` | `server/websearch.py` |
| `organize_capabilities`, `organize_plan`, `organize_apply`, `organize_undo` | `server/organizer.py` |
| `automation_*` | `server/automation.py` (high risk, must be armed) |

### Security + safety in the bridge

- **Path jail:** `bridge._resolve_path(target, must_exist=True)` is the *one*
  path resolver everywhere. It expands `~`, rejects anything outside
  `~/Documents/AURA` (configurable), refuses `/etc`, system folders, traversal
  (`..`), and rejects files where folders are needed.
- **Permissions:** `get_policy` / `set_policy` — the browser requests
  permissions; the server keeps a policy record.
- **Master Control gates:** at the top of `dispatch`, filters per flag:
  `pipe.docgen`, `dev.imageTest`+`pipe.images`, `pipe.websearch`,
  `pipe.organizer`, `pipe.automation`, `pipe.desktop`. Shell-critical calls
  (`system_info`, `get_policy`, `detect_apps`) are deliberately NOT gated so
  the app can never brick itself. A gated action returns
  `{ok:false, disabled:true, code:"feature_off", message:"…"}`.

## Browser → bridge client

`aura/js/actions/local-actions.js` — `LocalActions` class.

- `init()` probes `/api/status`, gets a token from `/api/token`, sets
  `available`.
- `run(action, params)` → `POST /api/action` with `X-AURA-Token`.
- Exposes typed helpers: `docCapabilities()`, `docBuild(kind, spec, folder, options)`,
  `openApp`, `openUrl`, `search`, `media`, `volume`, `screenshot`,
  `listDirectory`, `writeFile`, `readFile`, `orgPlan/orgApply/orgUndo`, and
  `automation*`. **Degrades honestly** — when the bridge is off it returns
  `{ok:false, needsSetup:true, message:"Restart with --allow-actions"}`.

## Adding a bridge action (recipe)

1. Write the backend function in `server/bridge.py` (or a module, e.g.
   `server/foo.py`).
2. Add `if action == "foo_bar":` in `dispatch()`.
3. If it's risky, check the policy first (`get_policy` semantics).
4. If it's optional/pipeline-y, add a Master Controls gate at the top of
   `dispatch` (see guide 09).
5. Add a typed helper in `js/actions/local-actions.js`.
6. Add a test in `tests/test-bridge-security.py` (server) and/or
   `tests/test-features.py` (pipeline-level).
