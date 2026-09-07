# 08 · FEATURES & APPS — manifest, launcher, intents

Feature popups ("make a ppt…", "write a report…", "research…") are modular
apps mounted in a modal host. One manifest is the single source of truth;
the terminal, tests and UI share the same feature ids.

## One variablized function per feature

This is a project rule: each feature has **ONE** function that owns its
behaviour (e.g., `service.generate()` for docgen). The popup, CLI and AI
engine all call it. Don't fork logic per entry point.

## The manifest

`aura/services/manifest.json` (Python truth) and
`aura/js/features/registry.js` (browser mirror, also `services/registry.py`).

Features (ids used everywhere):

| id | Service | UI app | Intent phrase example | Flag |
|----|---------|--------|----------------------|------|
| `pptx` | docgen | `apps/ppt-builder` | "make a ppt on X" | `apps.pptx` |
| `docx` | docgen | `apps/doc-builder` | "write a report on X" | `apps.docx` |
| `xlsx` | docgen | `apps/doc-builder` | "make a spreadsheet of X" | `apps.xlsx` |
| `research` | research | `apps/research` | "research X" | `apps.research` |

Each feature carries `params`, `defaults` (slides, theme, transition, speed,
animation, model, images config, sections, sheets…). The PPT defaults pin
`model: 'gemini-3.8-flash'` for outline and `gemini-3.1-flash-image` for
images.

## Launcher (`js/features/launcher.js`)

`openFeature(id, prefill, ctx)`:

1. Looks up the manifest (`feature(id)`); unknown → `{ok:false, reason}`.
2. **Master Controls gate:** checks `isOn('apps.' + id)`; blocked → toast +
   `{ok:false, reason:'feature off', flag:'apps.<id>'}`.
3. Injects modal CSS (once), creates `#feature-modal`, dynamic-imports
   `../../apps/<ui>/app.js`, calls `app.mount({root, meta, prefill, ctx, close})`.
4. Returns `{ok:true}` or `{ok:false, reason}`.

`ctx` carries `{engine, actions, config, bus, toast, audio}` — the popup
shares the live engine, so inside the popup "generate" uses the same model
and same actions client as the chat.

## Intent routing (`js/features/intent.js` + `js/main.js`)

- `parseFeatureIntent(text)` (in `intent.js`, unit-tested) recognises the
  phrases; `main.js ~3305` `maybeFeatureIntent(text)` routes typed input,
  wake-word input and STT through it.
- `openFeaturePopup(id, prefill)` (main.js ~3316) wraps `openFeature` with
  the shared context and adds the "🪟 X is open" system message **only when
  the popup actually opened**. If the feature is off, it pushes an honest
  "🔒 X is switched OFF in Master Controls" message instead — no dead popup,
  no false "open".
- The AI engine's own doc/research services (`js/ai/engine.js`
  `_runNovaService`) are gated with the same flags (`pipe.docgen`,
  `pipe.websearch`), so asking the agent directly can't bypass the launcher.

## Writing a new feature app (recipe)

1. Add the feature to `services/manifest.json` AND
   `js/features/registry.js` (id, label, icon, service, ui, params, defaults).
2. Create `aura/apps/<ui>/app.js` exporting `mount({root, meta, prefill, ctx, close})`.
   Use `ctx.actions`, `ctx.engine` — don't create new backend paths.
3. Add an intent phrase in `js/features/intent.js` + a test.
4. Add a flag in `persistence/feature_flags.py` (`kind:'app'`) so Master
   Controls can hide it.
5. Test: `tests/test-feature-registry.mjs` (registry consistency),
   `tests/test-feature-apps.mjs` (intents), your app's own test if it has
   logic worth pinning.

## Popup styling

`launcher.js` exports `MODAL_CSS` (dark glass modal, `#feature-modal` fixed
overlay). Keep feature apps self-contained; no new build tooling.
