# AURA — Desktop Integration Architecture

Status: **architecture complete, OS layer stubbed.** Runs today in simulation
mode; upgrades itself the moment a host process appears. No executable paths,
registry keys, or machine-specific values are hardcoded anywhere.

## Flow

```
        AI (any provider)
              │  emits structured JSON, never shell commands
              │  { "action": "launch_app", "target": "WhatsApp" }
              ▼
     ┌──────────────────┐
     │  ACTION MANAGER  │  1. is the action registered?
     │  (security gate) │  2. does the payload pass its schema?
     │                  │  3. is the permission granted?
     │                  │  4. within the rate limit?
     │                  │  5. confirmed, if destructive?
     └────────┬─────────┘  6. audit-logged either way
              ▼
      Desktop Plugin  ──▶  AppLauncher  ──▶  backend
                                              ├─ native  (planned)
                                              ├─ bridge  (server/serve.py, real today)
                                              └─ mock    (simulated, honest)
```

The AI has **no** path to the OS that skips this chain.

## Files

| File | Role |
|---|---|
| ../js/desktop/index.js` | `DesktopFramework` — assembles everything |
| ../js/desktop/permissions.js` | 13 permissions, risk tiers, deny-by-default |
| ../js/desktop/app-database.js` | 17 mock apps, aliases, cross-platform launchers |
| ../js/desktop/app-launcher.js` | `initialize/launchApp/closeApp/searchInstalledApps/getInstalledApps` |
| ../js/desktop/action-manager.js` | validation, permissions, rate limit, confirm, audit |
| ../js/desktop/plugins/index.js` | the 6 plugins |
| ../js/desktop/setup-flow.js` | 5-step first-run flow |
| ../js/ai/action-parser.js` | conversation ⇄ action routing |

## Permissions (13)

| Permission | Risk | Native? |
|---|---|---|
| Launch Applications | medium | yes |
| Close Applications | high | yes |
| Open Websites | low | no |
| File System Access | **critical** | yes |
| Terminal Access | **critical** | yes |
| Power Controls | **critical** | yes |
| Keyboard Automation | high | yes |
| Mouse Automation | high | yes |
| Clipboard | medium | no |
| Camera | medium | no |
| Microphone | medium | no |
| Media Control | low | yes |
| Screen Capture | high | yes |

All start **denied**. `Settings → Desktop → Permissions`.

## Plugins (6, 22 actions)

| Plugin | Actions | Status |
|---|---|---|
| Application Launcher | launch_app, close_app, search_apps, list_apps | ready (mock/bridge) |
| Browser Control | open_url, web_search | ready |
| File System | list_directory, read_file, write_file, open_folder | planned |
| Terminal | run_command, open_terminal | planned |
| Media | media_control, set_volume | needs local server |
| Windows Integration | screenshot, clipboard ×2, power_control, type_text, send_hotkey, mouse_click, focus_window | partial |

## AI dual-mode

Conversational input → normal prose. Actionable input → structured JSON.

Two extraction paths:
1. **Deterministic** (`intentToAction`) — "open whatsapp" resolves locally, no LLM round-trip.
2. **Model-driven** (`extractActions`) — parses ` ```action ` blocks. Provider-agnostic, so it works with Ollama, Groq, everything — no function-calling API needed.

## Adding a plugin

```js
framework.actions.registerPlugin({
  id: 'my-plugin', name: 'My Plugin', description: '…', icon: '🔧',
  permissions: ['launch_apps'],
  available: () => true,
  actions: {
    my_action: {
      permission: 'launch_apps',
      description: 'Does a thing',
      schema: { target: { type: 'string', required: true, maxLength: 80 } },
      confirm: false,
      run: async ({ target }) => ({ ok: true, message: `Did it to ${target}` }),
    },
  },
});
```

## What's left for local Windows work

Every stub is marked `TODO(local)`:

1. **Native companion** — small local process exposing `/native/status`, `launch`, `close`, `enumerate`, `scan`.
2. **App scanner** — 7 phases already specified in `AppLauncher.SCAN_PHASES` (Start Menu, registry, AppX, install dirs, URI handlers, icons, merge). `mergeScanResults()` is written and tested; only the collector is missing.
3. **Input automation** — SendInput / CGEvent / xdotool.
4. **File system + terminal** — with the path jail and command allowlist described in the plugin comments.

## Security notes

- Deny by default; grants persist per-permission.
- Schema validation drops unknown keys — the AI can't smuggle extra fields.
- Destructive actions need a token-matched confirmation.
  *A bug where `undefined === undefined` let this pass was caught by test and fixed.*
- Terminal design: **never** pass an AI string to a shell. Allowlist + argv array + `shell=false` + cwd jail + timeout.
- Every attempt is audited and visible in Settings.

## Tests

`node ../tests/test-desktop.mjs` — **145 assertions**, including that the AI is denied without permission and allowed with it.
