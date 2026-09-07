# 09 · MASTER CONTROLS — every feature switch, unbreakable

The competition rule: **only show working features**, but **no setting may
brick the site**. Master Controls (`/controls`, alias `/master`) is the one
page that lets you turn every page/panel/tab/app/pipeline on or off.

## The 35 flags

| Group (kind) | Flags |
|--------------|-------|
| **Pages** (6) | `page.live`, `page.phone`, `page.dev`, `page.db`, `dev.imageTest`, `page.controls` 🔒 |
| **Panels** (7) | `panel.chat` 🔒, `panel.vision`, `panel.dev`, `panel.system`, `panel.style`, `panel.mic`, `panel.voice` |
| **Settings tabs** (12) | `ui.ai`, `ui.voice`, `ui.vision`, `ui.interface`, `ui.connect`, `ui.devices`, `ui.appearance`, `ui.memory`, `ui.avatar`, `ui.desktop`, `ui.keys`, `ui.about` |
| **Feature apps** (4) | `apps.pptx`, `apps.docx`, `apps.xlsx`, `apps.research` |
| **Pipelines** (6) | `pipe.docgen`, `pipe.images`, `pipe.websearch`, `pipe.organizer`, `pipe.automation`, `pipe.desktop` |

🔒 = protected, can never be disabled (the API refuses).

## The safety model (the part that matters)

1. **DEFAULT = EVERYTHING ON.** Shipping state is untouched until you flip a
   toggle. The store (`aura.featureFlags` config row) only holds overrides.
2. **FAIL-OPEN everywhere.** Unknown ids, missing rows, corrupt JSON,
   non-bool values, a broken DB, a failed fetch → the feature resolves to
   **ON**. A bad value can never hide the app.
3. **Protected core:** `page.controls` (always a way back in) and
   `panel.chat` (always a way to talk) are locked. `set_flag` returns 400 for
   them.
4. **Validation:** ids must be in the registry; `enabled` must be a real
   boolean (0/1 accepted). Junk is never stored.
5. **Routing-layer gating, not CSS.** Hidden pages 404 honestly at the
   server; hidden apps are rejected in the launcher/intents/engine; hidden
   pipelines are rejected in the bridge and the docgen image engine.
   Remove the nav entry AND the route access together.
6. **Shell-critical calls never gated.** `system_info`, `get_policy`,
   `detect_apps` stay available so boot can't break even with
   `pipe.desktop` off.

## Where each layer checks

| Layer | File | Hook |
|-------|------|------|
| Registry + store | `aura/persistence/feature_flags.py` | `FLAG_DEFS`, `is_on`, `set_flag`, `reset`, `defs`, `state`, `counts` |
| API | `aura/persistence/api.py` | `GET/POST /api/db/flags`, `POST /api/db/flags/reset` |
| Server routes | `aura/server/serve.py` | `_feature_on()` used in every page route + `/dev/*` statics |
| Bridge | `aura/server/bridge.py` | top of `dispatch()` (per pipeline) |
| Docgen images | `aura/services/docgen/images.py` | `generate()` early-return `off:true` |
| Terminal | `aura/server/serve.py` | `/doc` command: "turned OFF in Master Controls" |
| Browser flags client | `aura/js/features/controls.js` | `loadFlags/isOn/applyFlagVisibility/setFlag/resetFlags` |
| Shell visibility | `aura/index.html` + `js/main.js` | `data-flag` attributes; `applyFlagVisibility()` at boot |
| Apps | `aura/js/features/launcher.js` | `openFeature` gate |
| Intents | `aura/js/main.js` | `openFeaturePopup` honest "off" message |
| AI services | `aura/js/ai/engine.js` | `docgen`/`research` cases |

## Adding a new flag (recipe)

1. `persistence/feature_flags.py` → add to `FLAG_DEFS`:
   ```python
   {"id": "pipe.thing", "kind": "pipeline", "default": True, "protected": False,
    "label": "…", "desc": "…"}
   ```
2. Gate the backend at the actual choke point (route / bridge dispatch /
   service entry) with the same fail-open pattern:
   ```python
   try:
       from persistence import feature_flags as _ff
       if not bool(_ff.is_on("pipe.thing")):
           return {"ok": False, "disabled": True, "code": "feature_off", "message": "…"}
   except Exception:
       pass   # fail-open
   ```
3. Gate the front end:
   - `data-flag="pipe.thing"` on the nav element (if it's a UI surface), or
   - `isOn('pipe.thing')` in `launcher.js` / `main.js` / `engine.js`.
4. Add API tests in `tests/test-controls.py` (registry, fail-open, protected,
   API, routing, pipeline, bridge) and a client test in `tests/test-controls.mjs`
   if the browser module changed.
5. The controls page itself needs **nothing** — it renders whatever the
   registry returns.

## Frequently asked traps

- **Don't hide by CSS only.** A hidden feature with a live route is a lie.
  Gate the server route too.
- **Never remove a pipeline while the engine still calls it.** Turning
  `pipe.images` off must leave `resolve_deck` able to fall back to native
  and report honestly — it must not throw.
- **Never let a toggle affect boot wiring.** `applyFlagVisibility` runs after
  boot; if the fetch fails nothing is hidden.
- **The page itself is protected** — you can always press RESET ALL.
