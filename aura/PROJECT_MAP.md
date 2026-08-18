# AURA — Project Map

A one-page index of what lives where and why. Read this first when you come
back to the code after a break.

---

## Run it

```powershell
python serve.py                    # http://localhost:8000
python serve.py --allow-actions    # + desktop control, web search, automation
python serve.py --allow-actions --allow-lan   # + reachable from your phone
```

Optional Python extras (AURA runs without all of them):

```powershell
pip install -r requirements.txt
```

| Package | Unlocks | Without it |
|---|---|---|
| `psutil` | Real CPU/RAM/disk in the System Center | Estimated values, labelled as such |
| `ddgs` | Web search | `/search` opens a browser tab instead |
| `trafilatura` | Reading the pages it finds | Search returns snippets only |
| `pyautogui` | Mouse + keyboard automation | The feature reports "not installed" |

---

## Server side (Python)

| File | Responsibility |
|---|---|
| `serve.py` | The only entry point. Static files, threaded HTTP, `/api/*` routes, the Ollama same-origin proxy, Windows console handling. |
| `bridge.py` | Desktop executor. App launching, file system (path-jailed), terminal (policy-gated), clipboard, media keys, app detection. The security boundary. |
| `ollama_proxy.py` | Forwards to Ollama so the browser never hits a cross-origin wall. Model discovery lives here. |
| `websearch.py` | ddgs search → trafilatura page reading → context for the model. Adaptive depth. |
| `automation.py` | Mouse/keyboard control. Highest-risk file in the project; read the header before touching it. |

**Security rule:** every dangerous decision is made server-side. The browser
proposes, Python disposes. The AI can influence what the browser asks for, so
it must never be the thing that decides.

---

## Browser side (`js/`, 56 modules)

```
core/        bus · state · config · plugins          the spine
ai/          engine · providers · intent-router · tools · model-registry
             local-core (offline brain) · memory · guide
memory/      memory-manager (4 layers) · storage (+ VectorStore w/ embeddings)
vision/      vision (MediaPipe) · gesture-classifier · face-recognition
             dwell (state machine + target classifier) · interaction-manager
             screen-share · screen-cursor · privacy-guard
voice/       speech (STT + TTS + viseme lip-sync, half-duplex echo guard)
avatar/      animation-engine ← the performance, provider-independent
             providers/ builtin · gltf (VRM/GLB) · readyplayerme
             spring-bones · mtoon · outfits · avatar-manager
desktop/     action-manager · permissions · app-launcher · app-database
             plugins/ (6 desktop plugins)
runtime/     local-runtime (the OS boundary) · hardware/ providers · metrics
ui/          command-center · theming · innovations · setup · markdown
plugins/     builtin · extended  (55+ slash commands)
gestures/    actions  (9 gestures → real behaviour)
ar/ audio/   ar · ambient
main.js      composition root — wires everything, owns the DOM
```

### The two rules that keep it maintainable

1. **Modules talk through the event bus, not to each other.** A plugin never
   imports the avatar. `test-architecture.mjs` enforces this.
2. **The AI layer never imports platform code.** `ai/` cannot reach
   `actions/` or `desktop/` directly — it goes through the tool layer.

---

## Tests (64 files, 2685 assertions)

```bash
./tests/run-all.sh          # everything
node tests/test-core.mjs    # no browser needed
python tests/test-bridge-security.py
```

| Kind | Files | Needs |
|---|---|---|
| **Node** | `test-core` `test-desktop` `test-models` `test-router` `test-providers` `test-actions` `test-live` `test-architecture` `test-voice-loop` `test-gesture-wave` `test-desktop-tools` `test-vision-embeddings` `test-screen-agent` `test-gestures-cursor` `test-task-agent` `test-runtime` `test-privacy-guard` `test-dwell` `test-doc-agent` `test-sphere` | nothing |
| **Python** | `test-bridge-security` `test-search-automation` `test-server-resilience` `test-windows-console` `test-server-concurrency` `test-capabilities` `test-overlay-vdesk` `test-devices` | nothing |
| **Browser** | `browser-test` `test-integration` `test-command-center` `test-avatar-providers` `test-theming-memory` `test-face-recognition` `test-vrm-mtoon` `test-new-features` `test-desktop-ui` `test-body` `test-guide` `test-ollama-live` `test-vision-capabilities` `test-automation-ui` `test-screen-ui` `test-screen-panel` `test-planner-height` `test-do-pipeline` `test-do-e2e` `test-task-e2e` `test-devconsole` `test-live-page` `test-privacy-ui` `test-owner-live` `test-phone-page` | playwright + a running server |

Helpers: `capture-release.py` (screenshots), `fake-ollama.py` (stub server),
`run-all.sh`.

> `tests/*.png` are debug artifacts regenerated on every run and are
> gitignored. The committed screenshots live in `screenshots/`.

---

## Documentation

| Doc | Read it when |
|---|---|
| `README.md` | Getting started, troubleshooting, known limits |
| `PROJECT_MAP.md` | You are here — orientation |
| `DESKTOP_CONTROL.md` | Screen/mouse/keyboard setup, safety model, limits |
| `DEVELOPER_GUIDE.md` | Adding a feature, plugin lifecycle, event flow |
| `ARCHITECTURE.md` | The five layers and why the boundaries exist |
| `FEATURE_STATUS.md` | Per-feature evidence + every bug ever fixed (60+) |
| `DESKTOP_ARCHITECTURE.md` | Permissions, the action manager, the security model |
| `MODELS.md` | Ollama routing and the parameter ceiling |
| `UI_COMMAND_CENTER.md` | The System Center panels and their data sources |
| `DEPLOY.md` | Serving it somewhere other than localhost |
| `BUGFIXES.md` | The most recent round of work |

---

## Where things are NOT

Common wrong guesses, to save you a search:

- **No build step.** No webpack, no bundler, no `npm run`. `index.html` loads
  ES modules directly. `jsconfig.json` is for editor type-checking only.
- **No backend database.** All state is `localStorage` / `IndexedDB`.
- **No API keys required.** Cloud providers are optional; Ollama is the
  default and runs locally.
- **`vendor/`** holds three.js, MediaPipe and the glTF loaders. It is 44 MB
  and deliberately committed so AURA works fully offline.

---

## Hidden things

- Type `aura` anywhere (outside a text field) → the **Innovations** page.
- `/innovations` does the same. Neither appears in `/help`.
