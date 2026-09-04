# AURA — Developer Guide

Everything you need to run, understand, and extend AURA locally.

---

## 1. Local setup (Windows)

```powershell
# Python 3.8+ — standard library only
python --version

# Optional: real CPU/RAM in the System Monitor
pip install psutil

# Optional but recommended: a local model
#   https://ollama.com/download
ollama pull gemma2:2b

cd aura
python server/serve.py --allow-actions
```

Browser opens at `http://localhost:8000`.

### What each flag actually changes

| Command | Chat | Camera | Ollama | Desktop control |
|---|---|---|---|---|
| `python server/serve.py` | ✅ | ✅ | ✅ | ❌ simulated |
| `python server/serve.py --allow-actions` | ✅ | ✅ | ✅ | ✅ **real** |
| Opening `index.html` directly | ⚠️ offline core | ❌ | ❌ | ❌ |

### First-run checklist

1. Boot log should show `Local runtime: bridge` (not `browser`)
2. `/models` should list your Ollama models
3. `/runtime` should show 🟢 Ollama and 🟢 Bridge
4. Settings → Desktop → grant **Launch Applications**
5. Type `open notepad` — it should actually open

If something is off, type `/selftest` or ask *"nothing is working"*.

---

## 2. Project structure

```
../                          (this folder = aura/)
├── index.html              single page; all panels live here
├── server/                 ══ Python back-end (entry + tools) ══
│   ├── serve.py              local server + Ollama proxy + /api/metrics
│   ├── bridge.py             desktop action executor (allowlisted)
│   ├── ollama_proxy.py       same-origin Ollama forwarding
│   ├── automation.py         mouse/keyboard (highest-risk file in the repo)
│   ├── devices.py · organizer.py · overlay.py · vdesk.py
│   ├── websearch.py          ddgs + trafilatura
│   └── windows_mgr.py
├── services/               ══ feature subsystems (canonical, common) ══
│   ├── manifest.json          ONE feature/themes/transitions/animations list
│   ├── registry.py            Python manifest reader
│   └── docgen/                builder · images · animations · outline · service
├── apps/                   ══ feature popup UIs (mounted by js/features/launcher) ══
│   ├── ppt-builder/app.js     design picker → AI images → motion → deck
│   ├── doc-builder/app.js     Word / spreadsheet
│   └── research/app.js        live web research
├── js/
│   ├── features/              registry (manifest mirror) · kit · launcher
│   ├── core/               ← Layer 1: foundation
│   │   ├── bus.js            event bus (54 events)
│   │   ├── state.js          reactive store (30 keys)
│   │   ├── config.js         persisted settings
│   │   └── plugins.js        plugin registry
│   ├── memory/             ← Layer 2: services
│   │   ├── memory-manager.js 4 memory categories
│   │   └── storage.js        storage abstraction + vector store
│   ├── realtime/
│   │   └── live-data.js      weather, news, markets, wiki
│   ├── runtime/            ← Layer 3: local runtime
│   │   ├── local-runtime.js  THE OS boundary
│   │   └── hardware/         providers, registry, metrics
│   ├── desktop/              action manager, permissions, app db
│   │   └── plugins/          6 desktop plugins
│   ├── actions/              server/serve.py bridge client
│   ├── ai/                 ← Layer 4: intelligence
│   │   ├── engine.js         orchestration, streaming
│   │   ├── intent-router.js  7-stage priority router
│   │   ├── tools.js          16 AI-callable tools
│   │   ├── model-registry.js task-based model routing
│   │   ├── guide.js          built-in self-documentation
│   │   ├── local-core.js     offline reasoning
│   │   ├── providers.js      6 provider adapters
│   │   └── memory.js         conversation memory
│   ├── plugins/            ← Layer 5: capabilities
│   ├── gestures/             gesture → action bindings
│   ├── ui/                 ← Layer 6: presentation
│   ├── avatar/               3D body, head, 2D fallback
│   ├── vision/               MediaPipe + gesture classifier
│   └── main.js             ← Layer 7: composition root
├── voice/                    wake_service.py + wake_phrases.json
├── persistence/              SQLite + DPAPI vault + migrations
├── scripts/                  dev harnesses (mic/stt/wake tests)
├── tests/                    52+ suites (./tests/run-all.sh)
├── docs/                     this folder — everything you are reading
├── css/ · vendor/ · screenshots/ · types/
├── serve.py                 legacy root shim → server/serve.py (kept for `python serve.py`)
└── docbuilder.py            legacy root shim → services/docgen/builder (same rule)
```

**Layer rule:** a module never imports from a higher layer. Enforced by `../tests/test-architecture.mjs`, which fails the build on violation.

---

## 3. Event flow

Everything integrates through one bus. Modules never import each other directly.

```
User types  →  AIEngine.send()
                    │
                    ├─ emit  ai:user-message      → UI renders bubble
                    │                             → MemoryCenter logs
                    │
                    ├─ IntentRouter.route()
                    │     emit  ai:routed          → AI Core panel, feed
                    │
                    ├─ [TOOL]  → ActionManager → permission check
                    │             emit desktop:action-executed / -denied
                    │
                    └─ [CONVERSATION] → provider stream
                          emit  ai:stream-start    → avatar "thinking"
                          emit  ai:stream-delta ×N → transcript, TTS
                          emit  ai:stream-end      → avatar idle
```

### Subscribing

```js
import { bus, EV } from './core/bus.js';

const off = bus.on(EV.GESTURE, ({ gesture, confidence }) => {
  console.warn(gesture, confidence);
});
off();                                   // unsubscribe

bus.on('*', ({ event, payload }) => {}); // everything (the activity feed does this)
```

Handler errors are isolated — one broken listener can't take down the app.

### Key events

| Namespace | Examples |
|---|---|
| `ai:` | `user-message` `stream-start/delta/end` `routed` `tool-call` `model-selected` |
| `voice:` | `stt-start/partial/final` `tts-start/viseme/end` `wake-word` |
| `vision:` | `camera-start/stop` `hands` `faces` `objects` `scene` |
| `gesture:` | `detected` `ended` `pointer` |
| `desktop:` | `action-executed` `action-denied` `permission-changed` |
| `memory:` | `ready` `cleared` |
| `runtime:` | `ready` `services` |
| `metrics:` | `sample` |

---

## 4. Plugin lifecycle

### Command plugin

```js
import { plugins } from './core/plugins.js';

plugins.register({
  id: 'weather-extra',
  name: 'Weather Extra',
  description: 'Adds a forecast command',

  commands: [{
    name: 'forecast',
    aliases: ['fc'],
    usage: '/forecast <city>',
    help: '7-day outlook',
    run: async (args, ctx) => {
      // ctx = { bus, state, config, ai, vision, voice, avatar,
      //         audio, ui, runtime, memory }
      return `Forecast for ${args}…`;   // markdown string
    },
  }],

  // optional: inject live context into every AI prompt
  context: (ctx) => `User's default city is ${ctx.config.get('defaultCity')}.`,

  // optional: subscribe to system events
  setup: (ctx) => ctx.bus.on('vision:camera-start', () => {}),

  teardown: (ctx) => {},
});
```

**Lifecycle:** `register()` → commands indexed → `setup(ctx)` → `plugin:registered` emitted → available in `/help`.

### Desktop plugin (OS-touching)

```js
runtime.desktop.actions.registerPlugin({
  id: 'my-plugin',
  name: 'My Plugin',
  icon: '🔧',
  permissions: ['launch_apps'],
  available: () => true,

  actions: {
    my_action: {
      permission: 'launch_apps',            // enforced before run()
      description: 'Does a thing',
      schema: { target: { type: 'string', required: true, maxLength: 80 } },
      confirm: false,                       // true = ask the user first
      run: async ({ target }, ctx) => ({ ok: true, message: `Did it to ${target}` }),
    },
  },
});
```

Every action passes through: **schema validation → permission check → rate limit → confirmation gate → audit log**. There is no path to the OS that skips this.

### Rebinding a gesture

```js
AURA.gestures.bind('peace', () => AURA.toggleAR());
```

---

## 5. AI pipeline

```
Input
  │
  ├─ pending confirmation? ──────────── yes → resolve, done
  ├─ memory context assembled
  │
  ├─ IntentRouter.route()  — 7 stages, first match wins
  │    1 SAFETY       destructive requests → refuse
  │    2 SYSTEM       UI control, slash commands
  │    3 TOOL         desktop actions
  │    4 MATH         arithmetic ← beats web lookup
  │    5 GUIDE        "how do I use this?" — no model needed
  │    6 LOCAL        time, memory, vision, offline KB
  │    7 WEB          weather, news, markets, wiki
  │    ⤷ CONVERSATION fall-through → the model
  │
  └─ model stream → extract ```tool blocks → ActionManager
```

Questions never trigger actions: *"how do I open WhatsApp"* is explained; *"open WhatsApp"* launches it.

Debug any decision:

```
/why what is 47*89
→ Route: MATH (priority 4, 98% confidence) — arithmetic
```

### Tool calling

The model emits:
```json
{ "type": "tool_call", "tool": "launch_application",
  "parameters": { "application": "WhatsApp" } }
```
and receives:
```json
{ "success": true, "tool": "launch_application",
  "message": "Application launched successfully" }
```

16 tools, defined in ../js/ai/tools.js`. Adding one is a single entry in the `TOOLS` object.

---

## 6. Memory architecture

| Category | Class | Persisted | Purpose |
|---|---|---|---|
| Conversation | `ConversationMemory` | ✅ 160 msgs | Chat history, rolling window |
| Preferences | `PreferenceMemory` | ✅ | Durable facts, confidence-scored |
| System state | `SystemStateMemory` | ❌ **by design** | Running apps, devices, events |
| Knowledge | `KnowledgeMemory` | ✅ | Learned info + vector search |

*System state is deliberately volatile — persisting it would make AURA claim an app is running after a reboot.*

Storage is an interface (`MemoryStorage`) with `InMemory`, `LocalStorage`, and `IndexedDB` providers. Swapping in SQLite or a real vector DB later requires no caller changes.

```js
await memory.preferences.set('userName', 'Commander', { confidence: 1 });
await memory.knowledge.learn({ text: 'The wifi password is hunter2', title: 'WiFi' });
const ctx = await memory.buildContext('what is the wifi password');
```

### Knowledge engine

`VectorStore` currently uses keyword/TF overlap scoring. The interface is already shaped for embeddings:

```js
// TODO(local): back with Ollama /api/embeddings + cosine similarity,
//              or sqlite-vec in the native companion.
```

---

## 7. Local runtime & desktop integration

```
AI Layer          reasoning, prompts, tool choice
    │  tool calls only
Action Layer      schema + permissions + audit
    │  runtime API only
Local Runtime     desktop · hardware · local services
    │
Operating System
```

The AI and UI contain **zero** `getUserMedia`, `speechSynthesis`, or `subprocess` calls. Everything goes through a provider or the Action Manager.

**Transport tiers**, chosen automatically:
- `native` — future companion (not built)
- `bridge` — `server/serve.py`, real today
- `browser` — no host process, actions simulated

### 13 permissions, denied by default

`launch_apps` `close_apps` `open_websites` `file_system` `terminal` `power_controls` `keyboard_automation` `mouse_automation` `clipboard` `camera` `microphone` `media_control` `screen_capture`

### Hardware abstraction

```js
const cam = await runtime.devices.startCamera();
// { ok: false, reason: 'Permission "Camera" is not granted' }
```

Six capabilities — camera, microphone, audio, GPU, sensors, XR — each with browser and mock providers. Add a native one:

```js
runtime.hardware.register('camera', new NativeCameraProvider(), { priority: true });
```

---

## 8. Adding a provider

../js/ai/providers.js` — each adapter is an async generator yielding text deltas:

```js
export const myProvider = {
  id: 'myprovider',
  label: 'My Provider',
  needsKey: true,
  defaultModel: 'my-model',
  models: ['my-model'],

  async *stream({ messages, model, key, signal, temperature, maxTokens }) {
    const res = await fetch('https://api.example.com/chat', {
      method: 'POST', signal,
      headers: { Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages, stream: true }),
    });
    await ensureOk(res, 'My Provider');
    for await (const evt of sseJson(res, signal)) {
      const d = evt.choices?.[0]?.delta?.content;
      if (d) yield d;
    }
  },

  async listModels({ key }) { return this.models; },
};

// register it
export const PROVIDERS = { openai, anthropic, gemini, groq, openrouter, ollama, myProvider };
```

`signal` support is what makes the Stop button real — don't omit it.

---

## 9. Testing

```bash
./tests/run-all.sh                 # everything (needs a running server)

node ../tests/test-core.mjs           # 108  maths, intents, bus, memory, gestures
node ../tests/test-providers.mjs      #  13  adapters vs real wire formats
node ../tests/test-actions.mjs        #  27  desktop intent parsing
node ../tests/test-live.mjs           #  22  live-data routing guards
node ../tests/test-desktop.mjs        # 138  action manager security
node ../tests/test-router.mjs         #  88  priority routing, memory, hardware
node ../tests/test-models.mjs         # 106  model ceiling + built-in guide
node ../tests/test-architecture.mjs   #  18  imports, cycles, layering, dead code

python ../tests/test-integration.py 8000    # 63  full app in Chromium
python ../tests/test-command-center.py 8000 # 54  live-data panels
python ../tests/test-guide.py 8000          # 19  guide with no model
python ../tests/test-desktop-ui.py 8000     # 24  permission gate end-to-end
python ../tests/test-body.py 8000           # 22  avatar + wardrobe + live APIs
python ../tests/browser-test.py             # 70  regression suite
```

Type-check:
```bash
npm install --no-save typescript
npx tsc --noEmit -p jsconfig.json      # must report 0 errors
```

Browser tests need Playwright:
```bash
pip install playwright && python -m playwright install chromium
```

`../tests/fake-ollama.py` simulates Ollama for testing without a real install.

---

## 10. Debugging

`window.AURA` is the live app instance:

```js
AURA.ai.providerLabel              // active model source
AURA.ai._lastRoute                 // last routing decision
AURA.runtime.status()              // transport, platform, capabilities
AURA.desktop.permissions.summary() // granted/total
AURA.metrics.latest                // CPU/RAM sample
await AURA.memoryManager.stats()   // all four memory categories
AURA.models.report()               // model routing table
AURA.commandCenter.refresh()       // repaint all panels
```

In-app: `/selftest` `/runtime` `/models` `/status` `/why <text>`

---

## 11. What's left for local implementation

Every stub is marked `TODO(windows)` or `TODO(local)` — 29 in total, all intentional.

| Area | File | Work |
|---|---|---|
| Native companion | `runtime/local-runtime.js` | Probe point exists; process not built |
| App scanner | `desktop/app-launcher.js` | 7 phases specified, `mergeScanResults()` done |
| File system | `desktop/plugins/index.js` | Needs a path jail |
| Terminal | `desktop/plugins/index.js` | Needs a command allowlist |
| Input automation | `desktop/plugins/index.js` | SendInput / CGEvent / xdotool |
| Native hardware | `runtime/hardware/providers.js` | Register with `{priority:true}` |
| Embeddings | `memory/storage.js` | Ollama `/api/embeddings` |

The architecture will not need redesigning — only these implementations.

---

## 12. Conventions

- **ES modules only.** No bundler, no transpiler, no build step.
- **JSDoc types.** `jsconfig.json` has `checkJs: true`; keep `tsc --noEmit` at zero errors.
- **Comments explain *why*,** not what. Non-obvious decisions get a note.
- **No fake data.** If a value can't be read, show the reason — never invent a number.
- **Errors are honest.** Say what failed and how to fix it.
- **Bus over imports.** Cross-module communication goes through events.
