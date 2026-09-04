# AURA — Layered Architecture

Upgraded from a chatbot into a layered AI operating system. Every layer talks
only to the one below it, through an interface.

```
┌─────────────────────────────────────────────────────────────┐
│ 1. FRONTEND            ../js/main.js · ui/ · avatar/ · ../css/     │
│    UI, avatar, wardrobe, visualisations, user interaction    │
└───────────────────────────┬─────────────────────────────────┘
                            │ event bus only
┌───────────────────────────▼─────────────────────────────────┐
│ 2. APPLICATION CORE    ../js/core/ · ../js/ai/ · ../js/memory/        │
│    bus · state · config · plugins · AI orchestration         │
│    intent router · tool definitions · 4-part memory          │
└───────────────────────────┬─────────────────────────────────┘
                            │ tool calls only — never OS calls
┌───────────────────────────▼─────────────────────────────────┐
│ 3. ACTION / TOOL       ../js/desktop/action-manager.js          │
│    schema validation · permissions · rate limit · confirm    │
│    · audit trail                                             │
└───────────────────────────┬─────────────────────────────────┘
                            │ runtime API only
┌───────────────────────────▼─────────────────────────────────┐
│ 4. LOCAL RUNTIME       ../js/runtime/                           │
│    desktop framework · hardware providers · local services   │
│    (Ollama proxy, fetch proxy, action bridge)                │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│ 5. PLATFORM            server/serve.py · server/bridge.py · [native TODO]  │
│    Windows-specific implementations go here                  │
└─────────────────────────────────────────────────────────────┘
```

**Hard rule:** the AI and UI layers contain no `getUserMedia`, no
`speechSynthesis`, no `subprocess`. Every machine capability is reached
through a provider or the Action Manager.

## 1. Local Runtime — ../js/runtime/`

| File | Role |
|---|---|
| `local-runtime.js` | `LocalRuntime` — the single OS boundary; `LocalServices` |
| `hardware/providers.js` | 6 capability interfaces + browser & mock implementations |
| `hardware/registry.js` | `HardwareRegistry` (provider selection) · `DeviceManager` (façade) |

Transport tiers, chosen automatically: `native` (planned) → `bridge`
(server/serve.py, real today) → `browser`.

Hardware access is permission-gated exactly like a desktop action —
`DeviceManager.startCamera()` returns `{ok:false, reason}` when the `camera`
permission is not granted.

## 2. Tool Calling — ../js/ai/tools.js`

**16 tools.** The model emits:

```json
{ "type": "tool_call", "tool": "launch_application",
  "parameters": { "application": "WhatsApp" } }
```

It receives:

```json
{ "success": true, "tool": "launch_application",
  "message": "Application launched successfully" }
```

Pipeline: `extractToolCalls` → `normalizeToolCall` → `validateToolCall` →
Action Manager (permissions) → `toToolResult`.

Legacy `{action, target}` blocks still work — `normalizeToolCall` maps them
onto the new tools, so nothing that previously functioned broke.

## 3. Memory — ../js/memory/`

| Category | Class | Persistence |
|---|---|---|
| A. Conversation | `ConversationMemory` | localStorage, capped at 160 msgs |
| B. Preferences | `PreferenceMemory` | localStorage, confidence-scored |
| C. System state | `SystemStateMemory` | **volatile by design** |
| D. Knowledge | `KnowledgeMemory` + `VectorStore` | localStorage + search index |

Storage is an interface (`MemoryStorage`) with `InMemory`, `LocalStorage` and
`IndexedDB` providers, so swapping in SQLite or a real vector DB later needs
no caller changes.

*System state is deliberately not persisted — otherwise AURA would claim an
app is still running after a reboot.*

## 4. Intent Router — ../js/ai/intent-router.js`

One ordered pipeline replaces the old first-match-wins matchers:

| # | Stage | Example |
|---|---|---|
| 1 | SAFETY | "delete everything on C:" → refusal |
| 2 | SYSTEM | "open the camera", `/help` |
| 3 | TOOL | "open WhatsApp" |
| 4 | **MATH** | **"what is 47*89" → 4,183** |
| 5 | LOCAL | "what time is it" |
| 6 | WEB | "what is quantum computing" |
| 7 | CONVERSATION | "write me a poem" |

**MATH outranks WEB**, which is the structural fix for the bug where
*"what is 47\*89"* returned the AK-47 Wikipedia article.

`/why <text>` prints the full pipeline trace for any input.

## 5. New plugins & APIs — ../js/plugins/extended.js`

6 plugins · 17 new commands. Every API verified CORS-enabled and keyless.

| Plugin | Commands |
|---|---|
| Dictionary | `/define` |
| GitHub | `/repo` `/ghuser` |
| Space | `/apod` `/sun` |
| Fun | `/joke` `/catfact` |
| Memory | `/remember` `/recall` `/learn` `/forget` |
| Runtime | `/runtime` `/why` `/tools` |

**52 commands from 17 plugins** total.

## Type safety

The project is **JavaScript ESM**, not TypeScript. `jsconfig.json` enables
`checkJs`, so JSDoc annotations are genuinely type-checked:

```bash
npx tsc --noEmit -p jsconfig.json     # 0 errors
```

`../types/external.d.ts` declares APIs that exist at runtime but are missing from
TypeScript's DOM lib (WebXR, prefixed AudioContext, Web Speech,
`performance.memory`) plus the vendored three.js / MediaPipe bundles. AURA
feature-detects all of them before use, so the declarations are accurate
rather than suppressions.

Vendored files carry `@ts-nocheck` — they are third-party artefacts, not AURA
source.

## Enforcement

`../tests/test-architecture.mjs` fails the build on architectural drift:

| Check | Guarantee |
|---|---|
| Module resolution | every relative import resolves |
| Export contracts | every named import exists |
| Dependency graph | no circular dependencies |
| Layer discipline | dependencies never point upward |
| Isolation | runtime/desktop/core never import UI |
| Isolation | the AI layer never imports platform code |
| Dead code | no orphaned private methods |
| Hygiene | no `debugger`, no stray `console.log` |
| TODOs | all scoped `TODO(local)` or `TODO(windows)` |
| Entry points | no dangling DOM refs; every panel/tab reachable |

## Remaining Windows work

All stubs marked `TODO(windows)` / `TODO(local)`:

1. **Native companion** — probe point already in `LocalRuntime.initialize()`.
2. **Native hardware providers** — `HardwareRegistry` selects by priority;
   `registry.register('camera', new NativeCameraProvider(), {priority:true})`.
3. **App scanner** — 7 phases in `AppLauncher.SCAN_PHASES`, merge logic done.
4. **Input automation / file system / terminal** — plugin stubs with
   documented safety designs.

The architecture will not need redesigning; only these implementations.
