# 10 · FRONTEND MAP — the shell, modules, settings

The shell is `aura/index.html` + `aura/js/*` (ES modules). No framework, no
build step.

## index.html structure (top to bottom)

| Block | What |
|-------|------|
| `<head>` + inline style | theme vars, boot overlay |
| `<header class="topbar">` | brand, live stats (CORE/FPS/VIS/DET/MEM), gesture icon, theme, AR, settings ⚙ |
| `<nav class="dock">` | CHAT, VISION, LIVE (`/screen` link), DEV, SYSTEM, STYLE, MIC, VOICE — each carries `data-flag` now |
| `<main class="stage">` | avatar host |
| Panels | chat / vision / devconsole / ops / wardrobe / screen panels |
| Settings modal | tabs `data-tab` + `data-flag`, panes `data-tab` |
| AR overlay, feature modal host (created by launcher) | — |

Settings tabs: `ai, voice, vision, ui, connect, devices, appearance, memory,
avatar, desktop, keys, about`. Tab switching is in `js/main.js wireSettings()`
(~line 940): removes `active` from all `.tab`/`.tabpane`, adds to the clicked
one, and lazily renders the pane (`renderAvatarManager`, `renderAppearance`,
`renderMemory`, `renderFaces`, `renderKeysSpend`, `refreshDevices`,
`renderWebResearch`, `renderAutomation` …). Switching tabs returns you to the
top.

## js/ directory

```
js/
├── main.js            # controller: boot, wires DOM, settings, toasts, intents
├── core/              # bus (event bus), state, config, plugins
├── ai/                # engine (chat + tool calls + _runNovaService), doc-agent, router
├── voice/             # speech in/out, wake word, viseme/audio
├── vision/            # camera, gestures, face, dwell
├── avatar/            # avatar3d, manager, wardrobe
├── features/          # registry.js, launcher.js, intent.js, controls.js, kit.js
├── actions/           # local-actions.js (bridge client)
├── desktop/           # runtime, world model, kernel, tools
├── memory/            # memory modules
├── realtime/          # websocket-ish event streams (voice events)
├── ui/  audio/  ar/  gestures/  plugins/  runtime/
```

## Centre of gravity (main.js)

| Concern | Location (approx.) |
|---------|--------------------|
| Boot / init | `init()` — wires everything, calls `applyFlagVisibility()` after `wireAuraLiveToggle()` |
| Panel open/close | `openPanel(id)` / `closePanel()` (keyboard: Space = mic, M = voice, `/` = focus chat, `,` = settings) |
| Settings | `wireSettings()`, `wireDesktopSettings()`, `wireAvatarSettings()`, `wireAppearance()`, `wireMemorySettings()`, `wireWebResearch()`, `wireAutomation()`, `wireDevices()`, `wireDocs()`, `wireAgentState()`, `wireTaskCards()` |
| AURA Live toggle | `wireAuraLiveToggle()` — legacy `auraLiveEnabled` config toggle |
| Intents | `maybeFeatureIntent(text)` ~3305 → `openFeaturePopup(id)` ~3316 |
| Toasts / system lines | `toast(type, msg)`, `pushSystemMessage()` |

## Event bus (`js/core/bus.js`)

`bus.on/emit` with events like `EV.AVATAR_EMOTION`, `action:result`,
`vision:face-recognized`. Cross-module communication goes through the bus —
don't reach into unrelated modules.

## config (`js/core/config.js`)

Browser-side config mostly mirrors server settings (`config.get/set`), e.g.
`auraLiveEnabled`, `faceGreeting`, `docFolder`. The **source of truth** for
persistent values is the server DB (`/api/db/settings`); old client-side
values can be migrated with `persistence/importer.py`.

## CSS

`aura/css/aura.css` (themes: `aura-blue`, command-gold, glass modifier) +
`live.css`. **`[hidden] { display:none !important; }`** is already declared —
that's what makes `data-flag` hiding work even on flex/grid elements.

## UI conventions

- Functionality first; honesty second; polish third.
- Anything unavailable says so (a button never lies).
- New panels/pages should be registered in the architecture test
  (`tests/test-architecture.mjs`) — it catches dangling DOM references.
