# 03 · ARCHITECTURE — how NOVA fits together

## The stack

- **No build step.** Browser side is vanilla ES modules (`<script type="module">`)
  loaded straight from the server. Server side is Python stdlib.
- **Two processes, one window:** the Python server (`serve.py`) serves files +
  JSON APIs, and runs a terminal REPL. The browser app is the UI + AI client.
- **AI CAN be local:** Ollama on `:11434` is detected automatically. The
  browser talks to it through `/api/ollama/*` proxy routes, so the model key
  and CORS stay on the server side.

## Layers (who talks to whom)

```
┌────────────────────────────── BROWSER ──────────────────────────────┐
│ index.html (shell)                                                  │
│   js/main.js ── boot orchestrator, DOM wiring, settings, toasts     │
│   js/ai/engine.js ── chat loop, tool calls, _runNovaService         │
│   js/ai/doc-agent.js ── prompt → structured outline (browser side)  │
│   js/features/* ── registry, launcher, intents, controls(flags)     │
│   js/actions/local-actions.js ── typed call wrapper for the bridge  │
│   apps/* ── modal feature UIs (ppt-builder, doc-builder, research)  │
└──────────────┬──────────────────────────────────────────────────────┘
               │  fetch /api/*  (JSON)
┌──────────────▼────────────── SERVER (serve.py) ─────────────────────┐
│  Handler.do_GET / do_POST / do_DELETE                               │
│   ├── pages (/ /screen /phone /db /dev /controls ...)               │
│   ├── /api/db/*        → persistence/api.py (DB, vault, flags)      │
│   ├── /api/ollama/*    → ollama_proxy                               │
│   ├── /api/voice/*     → wake + speech events                       │
│   ├── /api/devices/*   → server/devices.py                          │
│   └── /api/post/actions → bridge.dispatch(action, params)           │
│  bridge.py ── actions: desktop, doc, web, organize, automation…     │
│  services/docgen/* ── canonical document generation                 │
│  persistence/* ── SQLite + DPAPI vault + feature flags              │
└─────────────────────────────────────────────────────────────────────┘
```

## Boot order (browser)

In `aura/js/main.js` (the controller's `init`):

1. `config → audio → avatar → AI → voice → vision → plugins` (the header
   comment says it; the actual sequence follows it).
2. `wireSettings()` binds tab clicks; `wireAuraLiveToggle()` handles the
   legacy AURA-Live visibility option.
3. `applyFlagVisibility()` (from `js/features/controls.js`) runs **after**
   boot wiring — it hides every `[data-flag]` element whose flag is OFF and
   re-points the active settings tab if it got hidden.
4. `devConsole?.mount()` then event listeners (bus, keyboard, face enroll).

**Key safety property:** `applyFlagVisibility` is fail-open — if the flags
fetch fails, nothing is hidden, the site is fully visible, and the next call
retries.

## The one canonical pipeline (documents)

The terminal, the feature popup, and the AI engine all use the same path:

```
prompt ─► js/ai/doc-agent.js outline()  ──► spec (JSON)
spec  ──► bridge "doc_build" ──► services/docgen/service.generate()
                │
                ├─ outline validation / fallback (services/docgen/outline.py)
                ├─ visuals resolve_deck() (search → AI → native)
                ├─ builder.build_pptx/xlsx/docx (real OOXML)
                ├─ animations.apply_features() (transitions + per-paragraph motion)
                └─ honest report {path, embedded, failed, validation…}
```

**Rule:** the model never chooses a path. `bridge._resolve_path` is the only
path resolver and it jails everything under `~/Documents/AURA` (configurable
`docFolder`).

## AI providers

- **Ollama** (local) — auto-detected.
- **Gemini** (API key in Settings → AI Core; separate `gemini-image` key).
- **OpenAI** (chat key + `openai-image` key).
- **OpenRouter** (chat key + strict `openrouter-image` image-only key — never
  shared with chat/outline).
- **Offline core** — always available, says honestly it's offline.

Key separation is strict: outline/chat keys are never used for image calls and
vice versa (two-key RPM split).

## Persistence location

- DB: `%LOCALAPPDATA%\AURA\aura.db` on Windows, `~/.aura/aura.db` elsewhere;
  override with `AURA_DB_PATH`. Schema version 5 (migrations in
  `persistence/migrations/`).
- Vault: DPAPI-protected credential vault (Windows) / file-based fallback.
