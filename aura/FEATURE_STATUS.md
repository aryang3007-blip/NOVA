# AURA — FEATURE STATUS

**Rule:** a feature is **Working** only if executable code exists AND it was demonstrated by an automated test or a screenshot. Anything else is **Partial** or **Planned**.

Last verified: **2183/2183 green - 0 console errors - 0 TypeScript errors - 0 circular dependencies**. `test-desktop` (140), `test-core` (112), `test-models` (125), `test-router` (88), `browser-test` (70), `test-integration` (70), `test-command-center` (55), `test-avatar-providers` (51), `test-bridge-security` (48), `test-theming-memory` (44), `test-search-automation` (44+9), `test-desktop-tools` (37), `test-face-recognition` (32), `test-voice-loop` (30), `test-vrm-mtoon` (29), `test-actions` (27), `test-vision-embeddings` (36), `test-providers` (25), `test-new-features` (24), `test-desktop-ui` (24), `test-architecture` (23), `test-body` (22), `test-live` (22), `test-guide` (19), `test-capabilities` (21), `test-server-resilience` (18), `test-vision-capabilities` (14), `test-automation-ui` (17), `test-screen-agent` (112), `test-screen-ui` (43), `test-planner-height` (25), `test-do-pipeline` (15), `test-do-e2e` (7), `test-task-agent` (52), `test-task-e2e` (17), `test-runtime` (87), `test-devconsole` (31), `test-overlay-vdesk` (34), `test-live-page` (49), `test-privacy-guard` (81), `test-privacy-ui` (37), `test-owner-live` (22), `test-devices` (61), `test-phone-page` (29), `test-gestures-cursor` (57), `test-screen-panel` (31), `test-gesture-wave` (15), `test-ollama-live` (10), `test-server-concurrency` (8), `test-windows-console` (8).

Legend: 🟢 Working · 🟡 Partial (works with a stated caveat) · ⚪ Planned (not built)

---

## 1. AI Conversation — highest priority

| Feature | Status | Evidence |
|---|---|---|
| Streaming responses | 🟢 Working | Browser test measured **23 incremental deltas in 1.8 s**; token-by-token render |
| Conversation memory | 🟢 Working | Told it "my name is Commander Stark" → recalled it 2 turns later; `/memory` shows facts |
| Stop generation | 🟢 Working | Real `AbortController.abort()`; test confirms `streaming: true → false` |
| Continue generation | 🟢 Working | Test measured reply grow **196 → 378 chars** after Continue |
| Regenerate | 🟢 Working | Drops last reply, re-prompts; verified 307-char regenerated answer |
| Interrupt speaking | 🟢 Working | `speechSynthesis.cancel()` via button, Esc, fist gesture, open palm |
| Multi-provider support | 🟢 Working | 6 adapters (OpenAI, Anthropic, Gemini, Groq, OpenRouter, Ollama) verified against real wire formats in `test-providers.mjs` |
| Offline local core | 🟢 Working | Real recursive-descent math parser, unit conversion, intent router, 19-topic KB — 108 unit tests |
| Auto provider detection | 🟢 Working | Key → Ollama ping → local core fallback chain |
| Honest failure handling | 🟢 Working | On API error: shows the real message, then answers with local core. Never silently fakes |
| Vision context injection | 🟢 Working | Live scene description injected into system prompt each turn |

**Caveat, stated plainly:** with no API key, reasoning comes from the offline core — genuinely functional (math, units, dates, memory, vision, ~19 CS/science topics) but **not** a language model. It says so instead of inventing answers. Add a key in Settings → AI Core for full reasoning.

---

## 2. Hand Tracking & Gestures

| Gesture | Status | Bound action | Verified |
|---|---|---|---|
| 👋 Wave | 🟢 Working | AI greets aloud + happy emotion | temporal oscillation detector; end-to-end test |
| 🖐 Open Palm | 🟢 Working | Starts speech recognition, interrupts TTS | classifier 0.82 conf; test passed |
| 👍 Thumbs Up | 🟢 Working | Confirms pending action / "Mission acknowledged" | classifier 0.98 conf; test passed |
| ✌ Peace | 🟢 Working | Opens + focuses chat panel | classifier 0.62 conf; panel switch verified |
| ☝ Pointing | 🟢 Working | Reticle tracks fingertip, highlights UI | classifier 0.93 conf; reticle position verified |
| ✊ Fist | 🟢 Working | Hard halt: stops generation + speech | classifier 0.87 conf |
| 👎 Thumbs Down | 🟢 Working | Cancels pending action / stops generation | geometric classifier |
| 👌 OK | 🟢 Working | Spoken systems check | pinch-distance detection |
| 🤘 Rock On | 🟢 Working | Toggles generative music | index+pinky detection |

- 🟢 **MediaPipe HandLandmarker** — 21 3D landmarks, up to 2 hands, loaded and running
- 🟢 **Live skeleton overlay** — 21 connections, glowing, handedness labelled
- 🟢 **Confidence display** — live percentage + animated bar in the Vision panel
- 🟢 **Debounce + cooldown** — 5-frame stability requirement, 2.2 s per-gesture cooldown (configurable)
- 🟢 **Rebindable** — `gestureActions.bind(name, handler)` at runtime, no core edits

---

## 3. Webcam Vision

| Feature | Status | Notes |
|---|---|---|
| Live webcam feed | 🟢 Working | `getUserMedia`, mirror toggle, front/rear selection |
| Hand detection | 🟢 Working | MediaPipe HandLandmarker |
| Face detection | 🟢 Working | FaceLandmarker, 478 landmarks + 52 blendshapes |
| Object detection | 🟢 Working | EfficientDet-Lite0, 80 COCO classes (opt-in — heaviest model) |
| Facial-expression reading | 🟢 Working | Real blendshape math → happy/sad/surprised/angry/focused; avatar mirrors it |
| Scene description to AI | 🟢 Working | `/see` and "what do you see" return actual detections |
| Snapshot capture | 🟢 Working | `/snapshot` downloads frame + overlays as PNG |
| GPU→CPU auto-tuning | 🟢 Working | Benchmarks inference, switches delegate if GPU is slow. Measured **760 ms GPU (SwiftShader) → 94 ms CPU**, an 8× gain |

**Caveat:** requires a secure context (`localhost` or `https`). Opening `index.html` via `file://` cannot access the camera — AURA detects this and says so instead of failing silently.

---

## 4. Animated Avatar

| Feature | Status | Evidence |
|---|---|---|
| Blink | 🟢 Working | Stochastic 2–7 s timer + 13 % double-blink; test measured lids reaching fully closed (1.00); see `tests/shot-blink.png` |
| Idle motion | 🟢 Working | Layered sine breathing, head sway, gaze saccades every 0.8–3.4 s |
| Lip-sync | 🟢 Working | 10-viseme set driven by TTS `boundary` events; test measured mouth height **0.060 → 0.789** on viseme input |
| Emotions | 🟢 Working | 10 poses (brow/eye/mouth/hue), smoothly damped; test verified happy pose curve 0.63 |
| Gesture reactions | 🟢 Working | Nod / tilt / shake / pulse impulses per gesture |
| 3D renderer | 🟢 Working | Three.js procedural hologram — no model files to 404 |
| 2D fallback | 🟢 Working | Full canvas implementation with identical animation contract, auto-selected if WebGL is unavailable |

---

## 5. Speech System

| Feature | Status | Notes |
|---|---|---|
| Speech-to-text | 🟡 Partial | Fully implemented via Web Speech API. **Works in Chrome/Edge/Safari; Firefox does not implement it** — AURA detects this and shows the reason instead of a dead button |
| Text-to-speech | 🟢 Working | `speechSynthesis` + markdown stripping + Chrome 15 s-cutoff workaround |
| Incremental speech | 🟢 Working | Speaks each sentence as it streams — starts talking before generation finishes |
| Viseme generation | 🟢 Working | Grapheme→viseme mapping, timing verified (4 visemes summing to exactly 500 ms) |
| Wake word | 🟢 Working | Continuous recognition scanning for the trigger word; enable in Settings → Voice. Same browser caveat as STT |
| Voice selection | 🟢 Working | `/voices` lists them; picker in Settings |

**Caveat:** browsers expose no phoneme-timing API. Lip-sync is derived from real word-boundary events plus grapheme mapping — genuine text-driven sync, not random mouth flapping, but not phoneme-perfect.

---

## 6. Architecture

| Property | Status | Notes |
|---|---|---|
| Modular separation | 🟢 Working | `ai/ voice/ vision/ avatar/ gestures/ ar/ audio/ core/` — modules never import each other, only the bus |
| Event bus | 🟢 Working | 40+ named events, error isolation, wildcard subscribers, history buffer |
| Plugin system | 🟢 Working | **8 plugins / 24 commands**, all registered through the same public API a third party would use |
| No hardcoded logic | 🟢 Working | Gestures, commands, themes, providers are all data-driven registries |
| Reactive state store | 🟢 Working | Shallow-compare watchers, no redundant DOM writes |
| Zero build step | 🟢 Working | Native ES modules; no bundler, no `npm install` |
| Offline capable | 🟢 Working | Three.js + MediaPipe WASM + all 3 models vendored (~43 MB), CDN fallback |

---

## 7. Interface & Extras

| Feature | Status | Notes |
|---|---|---|
| Holographic HUD | 🟢 Working | Corner brackets, scanlines, grid floor, particle constellation field |
| 6 themes | 🟢 Working | Live CSS-variable swap; canvas overlays read the same vars |
| Responsive | 🟢 Working | Grid re-flows to stacked mobile layout, verified at 420 px |
| Ambient audio | 🟢 Working | Synthesised pink-noise bed + detuned drones — no audio files |
| Generative music | 🟢 Working | Pentatonic arpeggiator with feedback delay |
| UI sound effects | 🟢 Working | 10 synthesised cues |
| Settings persistence | 🟢 Working | localStorage with graceful in-memory fallback |
| Accessibility | 🟢 Working | ARIA roles/live regions, focus-visible rings, `prefers-reduced-motion`, keyboard shortcuts |
| XSS-safe rendering | 🟢 Working | Escape-first markdown renderer; test injects `<img onerror>` and `<script>` — both neutralised |
| Self-test | 🟢 Working | `/selftest` exercises 15 subsystems live, reports 13+ nominal |

### AR Mode

| Path | Status | Notes |
|---|---|---|
| WebXR immersive-AR | 🟡 Partial | Fully implemented incl. hit-testing and surface anchoring. **Cannot be verified in this environment** (no XR device); runs on Android Chrome / Quest |
| Simulated AR fallback | 🟢 Working | Camera passthrough + device-orientation parallax (mouse parallax on desktop). Verified active. **Labelled "SIMULATED AR" on screen** so it is never mistaken for real WebXR |

---

## 8. Desktop Control (Local Action Bridge)  — NEW

Runs through `serve.py`, which executes on **your** machine. Off by default; enable with `python3 serve.py --allow-actions`.

| Feature | Status | Evidence |
|---|---|---|
| Open apps by voice/text | 🟢 Working | "open whatsapp" → real launch. Verified end-to-end: chat → intent parser → bridge → OS |
| 18-app allowlist | 🟢 Working | WhatsApp, Telegram, Spotify, Discord, Slack, VS Code, terminal, files, YouTube, Gmail… |
| Deep-link → binary → web fallback | 🟢 Working | Tested: GitHub app absent → opened web version, and *said so* |
| App detection | 🟢 Working | `/apps` reports what is actually installed on your OS |
| Media keys | 🟢 Working | "play music", "next song" (playerctl / AppleScript / Win keybd_event) |
| Volume control | 🟢 Working | "volume 40", "volume up", "mute" |
| Screenshot | 🟢 Working | `/screen` saves a PNG to your home folder |
| Natural-language routing | 🟢 Working | 27 intent tests, incl. 8 negatives that must NOT hijack chat |

**Security — verified by test, not asserted:**

| Attack | Result |
|---|---|
| No token | `401` |
| Wrong token | `401` |
| Cross-origin call | Blocked (no `Access-Control-Allow-Origin`) |
| Injection `whatsapp; rm -rf /tmp` | Rejected — allowlist only, `shell=False` |
| `file:///etc/passwd` | Blocked |
| `javascript:` / `ssh://` / `data:` | Blocked |
| 9 KB payload | `413` |
| Unknown action `exec` | Rejected |

Bound to `127.0.0.1`. Random token per launch. Every action logged to your terminal. **No arbitrary shell execution exists in the code path.**

## 9. Hybrid AI Routing (Ollama)  — NEW

| Feature | Status | Notes |
|---|---|---|
| Route small tasks to local Ollama | 🟢 Working | Short/simple turns → your `localhost:11434` model (free, private, fast) |
| Escalate hard tasks to cloud | 🟢 Working | Long, code-shaped or reasoning-heavy prompts → your cloud provider |
| Auto-fallback on local failure | 🟢 Working | If Ollama errors mid-stream, silently retries on the cloud model |
| Live routing indicator | 🟢 Working | Composer hint shows `local · llama3.2` when a turn was handled locally |
| Configurable | 🟢 Working | `hybridRouting`, `ollamaSmallModel`, `hybridMaxWords` in config |

---

## 10. Onboarding & Ollama  — NEW

| Feature | Status | Evidence |
|---|---|---|
| **Ollama CORS fix** | 🟢 Working | Root cause of "Ollama doesn't work": page on :8000, Ollama on :11434 = cross-origin, preflight rejected unless `OLLAMA_ORIGINS` is set. AURA now proxies `/api/ollama/*` through `serve.py` → same-origin → **works with a stock install, zero config**. Verified streaming end-to-end. |
| First-run setup wizard | 🟢 Working | Auto-opens when no brain is configured; correctly stays hidden when one is found |
| One-click model install | 🟢 Working | `ollama.pull()` streams NDJSON progress → live progress bar. No terminal needed. |
| **Live model discovery (no hardcoded names)** | 🟢 Working | Every model name comes from a live `/api/tags` call — the same data `ollama list` prints. The old curated catalog was **removed**: it made AURA offer and select models the user had never pulled. `ollama.defaultModel` is `null` until discovery runs. Guarded by `test-providers` ("no invented tags hardcoded") and `test-ollama-live` (real browser, model names AURA has never seen). |
| Wrong/misspelled model auto-correction | 🟢 Working | `resolveModel()` snaps a bad name onto a real installed one (`gemma2` → `gemma2:2b`, `coder` → `qwen2.5-coder:7b`) and always reports the substitution. Enforced again server-side in `serve.py` with an `X-AURA-Model-Note` header, so a bad name can never reach Ollama. |
| Install suggestions | 🟢 Working | `SUGGESTED_IF_EMPTY` is shown **only** when zero models are installed, and never participates in routing. Proven: with any model installed, `catalog()['suggested'] == []`. |
| API-key path with live test | 🟢 Working | Pick provider → paste key → real connection test before proceeding |
| Camera/mic diagnostics | 🟢 Working | Reports insecure context, iframe blocking, denied permission, missing device, or in-use-by-another-app — each with the fix |
| Explicit mic permission | 🟢 Working | Calls `getUserMedia` before `SpeechRecognition`, because Chrome otherwise fails silently |

---

## 11. Full-Body Avatar + Wardrobe  — NEW (was the #1 outstanding item)

| Feature | Status | Evidence |
|---|---|---|
| Full-body humanoid | 🟢 Working | 19-bone rig (5 spine + 7×2 limbs), ~7.5-heads proportions, procedural — **zero downloads, 100% offline** |
| Real skeleton posing | 🟢 Working | Meshes parent to bones; posing a bone moves everything attached |
| Body gestures | 🟢 Working | WAVE raises the actual arm (verified rotation < −0.3 rad); PEACE raises both (L=−2.33, R=−2.47) |
| Idle animation | 🟢 Working | Breathing, weight shift, limb sway, gaze saccades — verified arms + head move |
| Lip-sync on body | 🟢 Working | Mouth 0.18 → 0.87 on viseme input |
| **7 outfits** | 🟢 Working | Hologram, Tactical Suit, Flight Jacket, Hoodie, Exo Armor, Lab Coat, Formal |
| **6 colour palettes** | 🟢 Working | Cyan, Violet, Emerald, Amber, Crimson, Mono — recolours body, wireframe, eyes, lights, particles |
| **5 accessories** | 🟢 Working | HUD Visor, Orbit Halo (spins), Headset, Cape (cloth ripple), None |
| Wardrobe panel | 🟢 Working | Live swap + randomise; choices persist to localStorage |
| Form switch | 🟢 Working | Full body ⇄ head-only ⇄ 2D, hot-swappable at runtime |
| AR floor anchoring | 🟡 Partial | Body scales to ~1.6 m and anchors to a floor hit-test (head-only floats at eye level). Code path verified; **needs a real XR device to confirm** |

## 12. Real-Time Data  — NEW

All sources verified to send `Access-Control-Allow-Origin: *` — **no API key required**.

| Source | Status | Live result captured in test |
|---|---|---|
| Weather + 3-day forecast (Open-Meteo) | 🟢 Working | "Delhi, India — 28°C, partly cloudy, feels like 36°C" |
| Crypto prices (CoinGecko) | 🟢 Working | "BITCOIN $63,831 +0.51% (24h)" |
| Currency (Frankfurter) | 🟢 Working | "100 USD = 9,565 INR" |
| Wikipedia | 🟢 Working | Live summary + link |
| Tech news (Hacker News) | 🟢 Working | Top stories with scores |
| World news (BBC RSS) | 🟢 Working | Via allowlisted `/api/fetch` proxy (news sites send no CORS headers) |
| **Offline master switch** | 🟢 Working | `/offline on` blocks every lookup; verified AURA then refuses instead of guessing |
| Geolocation | 🟢 Working | Browser GPS with a configurable default-city fallback |

**Security:** the fetch proxy is allowlisted to 9 news domains. Verified blocked: arbitrary hosts, `127.0.0.1` (SSRF), and `file://`.

## 13. Glass UI  — NEW

| Feature | Status | Evidence |
|---|---|---|
| Frosted glass surfaces | 🟢 Working | `backdrop-filter: blur(26px) saturate(1.5)` verified live on panels, topbar, dock, modals, composer, toasts |
| Toggleable | 🟢 Working | Settings → Interface → Glass UI |

---

## 14. Desktop Integration Framework  — NEW

Full architecture; OS layer intentionally stubbed. See `DESKTOP_ARCHITECTURE.md`.

| Component | Status | Evidence |
|---|---|---|
| Action Manager (security gate) | 🟢 Working | AI denied without permission, allowed with it — verified in-browser |
| Permission system (13) | 🟢 Working | Deny-by-default, risk tiers, persistence, audit log |
| App database (17 mock apps) | 🟢 Working | Aliases, cross-platform launchers, **no hardcoded paths** (asserted) |
| App Launcher service | 🟢 Working | `initialize/launchApp/closeApp/searchInstalledApps/getInstalledApps` |
| 6 desktop plugins (22 actions) | 🟢 Working | Registered, schema-validated, honest status badges |
| Setup flow (5 steps) | 🟢 Working | Host detection, permission selection, scan step, review |
| Settings → Desktop panel | 🟢 Working | Apps, permissions, plugins, status, audit, **disabled scan button** |
| AI dual-mode | 🟢 Working | Prose vs structured actions; maths/chat never hijacked |
| Confirmation gate | 🟢 Working | Destructive actions require yes/no |
| Rate limiting | 🟢 Working | Token bucket per action |
| **Windows scanner** | ⚪ Planned | Deliberately not built — 7 phases specified, `mergeScanResults()` ready |
| **Native companion** | ⚪ Planned | Probe + backend switch written; process itself not built |

---

## 15. Layered Architecture Upgrade  — NEW

See `ARCHITECTURE.md`.

| Component | Status | Evidence |
|---|---|---|
| Local Runtime layer | 🟢 Working | `LocalRuntime` owns desktop + hardware + services; AI/UI never touch the OS |
| Hardware abstraction (6 providers) | 🟢 Working | Camera, mic, audio, GPU, sensor, XR — browser + mock implementations |
| Hardware permission gate | 🟢 Working | `startCamera()` denied without the `camera` permission — verified |
| Tool calling (16 tools) | 🟢 Working | Spec-shaped `{type:'tool_call'}` in, `{success,tool,message}` out |
| Legacy action compatibility | 🟢 Working | Old `{action,target}` blocks still map correctly |
| Memory: conversation | 🟢 Working | Rolling window, dropped-topic surfacing |
| Memory: preferences | 🟢 Working | Confidence-scored; low-confidence excluded from prompts |
| Memory: system state | 🟢 Working | Volatile by design; tracks apps/plugins/devices |
| Memory: knowledge + vectors | 🟢 Working | `/learn` then `/recall` verified end-to-end |
| Priority intent router | 🟢 Working | 7 stages; **MATH outranks WEB** |
| Extended plugins (6) | 🟢 Working | Dictionary, GitHub, Space, Fun, Memory, Runtime |
| `jsconfig.json` type-checking | 🟢 Working | `checkJs` on JSDoc — project is JS, not TS |

---

## 16. Command Center UI  — NEW

Presentation layer only. See `UI_COMMAND_CENTER.md`.

| Panel | Status | Data source |
|---|---|---|
| AI Core visualisation | 🟢 Working | Live state + `ai:*` events; 6 reasoning states |
| System Monitor | 🟢 Working | **Real psutil telemetry** via new `/api/metrics` |
| Agent Status (5 agents) | 🟢 Working | State store + runtime + registries |
| Memory Center | 🟢 Working | `MemoryManager` — counts match the engine |
| Voice Interface | 🟢 Working | `voice:*` events; 4 states, waveform |
| Plugin & Tool Center | 🟢 Working | Live `PluginRegistry` + `ActionManager` |
| Activity Feed | 🟢 Working | `bus.on('*')` wildcard, noisy events muted |
| Glass HUD styling | 🟢 Working | Holographic panels, cyan/blue, 60 FPS animations |
| **No fake data** | 🟢 Verified | Automated audit greps DOM for placeholders |

**Honest limitation:** the listening waveform's amplitude is animated, not
measured — browsers don't expose mic levels without an AnalyserNode. Speaking
amplitude is real (TTS viseme openness).

---

## 17. Built-in Guide & Model Routing  — NEW

See `MODELS.md`.

| Feature | Status | Evidence |
|---|---|---|
| Built-in guide (11 topics) | 🟢 Working | Answers "how do I use this" with **no model at all** |
| Guide reads live state | 🟢 Working | Says "camera is off" vs "camera is live · 2 hands" |
| GUIDE router stage | 🟢 Working | Priority 5 — above web, below maths |
| Model auto-discovery | 🟢 Working | Reads Ollama; **no hardcoded model names** |
| Capability inference | 🟢 Working | coder→code, r1→reasoning, from name+size |
| **Size ceiling (9B)** | 🟢 Working | 20B/30B **never** auto-selected — verified per task |
| Deliberate pinning | 🟢 Working | `/pin` overrides the ceiling, with a warning |
| Measured-latency demotion | 🟢 Working | Slow models dropped from auto-routing |
| `/models` `/pin` `/guide` | 🟢 Working | Honest output when Ollama is absent |

---

## 18. Release Stabilisation  — FINAL

Full audit before local handoff. No features added; only correctness work.

| Check | Result |
|---|---|
| Relative imports resolve | ✅ 93/93 |
| Named imports have exports | ✅ 0 missing |
| Circular dependencies | ✅ 0 |
| Layer violations | ✅ 0 |
| Runtime imports UI | ✅ never |
| AI imports platform code | ✅ never (fixed) |
| Orphaned private methods | ✅ 0 (1 removed) |
| `debugger` / stray `console.log` | ✅ 0 |
| TODOs scoped to platform work | ✅ 29/29 |
| DOM refs / panels / tabs reachable | ✅ all |
| **TypeScript errors** | ✅ **0** (from 900) |
| Node tests | ✅ 520 |
| Browser tests | ✅ 252 |

### Fixed in this pass

1. **AI layer imported platform code** — `engine.js` pulled in
   `actions/local-actions.js` for a legacy bridge path that became
   unreachable once `LocalRuntime` began initialising the desktop framework at
   boot. Removed the path and the import: one fewer layer violation and one
   less duplicate code path to the OS.
2. **Orphaned method** — `_runActionIntent` had no callers after that removal.
3. **900 TypeScript errors → 0.** 518 came from vendored bundles being
   type-checked (now `@ts-nocheck`); the rest were JSDoc typedefs that under-
   declared what functions actually returned. Fixed the contracts rather than
   suppressing the errors.
4. **Audit self-corrections** — three findings were bugs in my own analysis,
   not the code: `class="tab"` also matched `tabpane`; the word "TODO" in
   prose was treated as a marker; `js/realtime/` was mis-classified as a
   plugin when it is a service.

---

## 19. Dwell-to-Click  — NEW (v0.20, the last deferred spec item)

Spec §4/§5. Hold a pointing fingertip still and it clicks whatever is under it.
Rides the **existing** `EV.POINTER` stream, so it adds no camera work.

| Feature | Status | Evidence |
|---|---|---|
| Dwell state machine (IDLE→ARMING→DWELLING→COMMITTED→COOLDOWN) | **Working** | `js/vision/dwell.js`, 91 assertions |
| Progress ring 0 → 25 → 50 → 75 → 100% | **Working** | painted on the vision overlay; 3242 px measured |
| Target classifier: AURA control vs Windows desktop | **Working** | `classifyTarget()`, pure + unit-tested |
| Click a control inside AURA | **Working** | real `MouseEvent` with real `clientX/Y`; handler proven to run |
| Click the Windows desktop | **Partial** | code path complete; unexercised here — no display, no pyautogui |
| `Vision Mouse Control` permission | **Working** | denies by default; refusal names the permission |
| Jitter tolerance + dropped-frame grace | **Working** | fires through ±1.2% jitter and a 165 ms dropout |
| Frame-rate independence | **Working** | 8 fps and 60 fps agree within one slow frame |
| Refractory period (no machine-gun clicks) | **Working** | 20 s of a motionless hand = exactly 1 click |
| Settings UI: enable, hold time, steadiness | **Working** | slider retunes the live machine (verified 1000→1600 ms) |

**Why it is a state machine and not a counter.** A hand is never still —
MediaPipe's index tip jitters 1–3% of frame width even when someone believes
they are holding perfectly steady, and it drops frames whenever the CPU is
busy. A naive `if (samePlace) counter++` either fires on a hand merely passing
over a button, or never fires because one jittery frame resets it. So:
tolerance instead of equality (with an eased anchor, forgiving slow drift),
grace frames for dropouts, and elapsed **milliseconds** rather than frame
counts — on a machine that runs 8–30 fps, counting frames would make dwell take
three times longer when the CPU is loaded.

**Two kinds of click, two security stories.** Clicking one of AURA's own
buttons crosses no trust boundary — it is your own page — so it needs no
permission. Clicking the *desktop* needs `Vision Mouse Control` **and** a
full-monitor share **and** an armed bridge. Each refuses out loud.

### Honest limitation

Desktop clicks are **unexercised**. This sandbox has no display and no
pyautogui, so that path returns the bridge's genuine refusal
(`ModuleNotFoundError: No module named 'pyautogui'`) rather than a fake
success. The coordinate maths, the permission gate and the window-vs-monitor
refusal are all tested; what is untested is whether a real click lands on the
right Windows pixel. That depends on grid accuracy, which is still the most
likely thing to be wrong on real hardware.

---

## 20. Document Generation + File Organiser + QR Pairing — NEW (v0.21)

Added after comparing AURA against **Brahma Echo**, a similar Windows assistant.
Most of that feature list AURA already had, often deeper. Five things were
genuinely missing; all five are now built.

| Feature | Status | Evidence |
|---|---|---|
| PowerPoint generation | **Working** | valid OOXML, `ppt/presentation.xml` present, text verified in-package |
| Spreadsheet generation | **Working** | headers bold, panes frozen, numbers numeric, formula injection neutralised |
| Word document generation | **Working** | headings, paragraphs and `List Bullet` styles verified |
| AI outline from a prompt | **Working** | Gemini / OpenRouter / Ollama, plus an offline template |
| File organiser | **Working** | preview → confirm → apply → undo, journalled |
| QR pairing | **Working** | rendered QR screenshotted and decoded by OpenCV |
| Configurable save folder | **Working** | Settings → Devices → Generated files |
| Smart-home | **Dropped** | by your decision; stays on the Innovations page |

### The design rule that matters

**The AI writes content, never paths.** `js/ai/doc-agent.js` turns a prompt into
a structured outline; `docbuilder.py` renders that outline to disk. A model that
hallucinates cannot name a file, choose a folder, or pick an extension — the
worst it can do is write a badly-worded slide.

Three consequences worth stating:

* Every output path goes through the **same `bridge._resolve_path` jail** as the
  file plugin. Writing to `/etc`, `/`, or `~/.ssh` is refused; a `../../escape`
  filename cannot leave the folder.
* The **extension is forced** to match the builder, so a "presentation" can
  never be written as `.exe`.
* Spreadsheet cells beginning `=`, `+`, `-` or `@` are prefixed with `'`, so a
  generated sheet cannot carry a formula-injection payload into Excel.

### Why the organiser previews first

Moving files is destructive in the way that matters most: silently. So `plan()`
touches nothing and returns exactly what would move; `apply()` refuses unless
handed that plan's token, re-verifies every source is still where the plan said,
and rejects a token that is stale (>5 min), replayed, or from a different
folder. Every run is journalled, so `/organize undo` restores all of it —
including files renamed to avoid a clash.

Verified: symlinks are never followed, hidden files and existing folders are
skipped, running twice is a no-op, and 10/10 files return on undo.

### Honest limitations

* **Outline quality is the model's, not AURA's.** A 2B local model writes thin
  bullets. The structure, formatting and file validity are guaranteed; the prose
  is only as good as whatever is answering.
* **No charts, images or themes yet** — text, tables and bullets only.
* **`.doc`/`.ppt` (legacy binary) are not produced**, deliberately. Modern OOXML
  only.
* The organiser is **not recursive**: it sorts loose files in one folder, so an
  already-tidy tree is never re-shuffled.

---

## 21. Command Center Identity — NEW (v0.22)

Built against a detailed "Brahma Echo Lite" specification. The spec asked for a
React + TypeScript + Tauri rewrite; you chose to **keep AURA's stack** and build
the missing capability instead. That was the right call — the stack is a means,
the experience is the goal, and 2,533 passing assertions are not worth
discarding for a framework preference.

### Delivered this round

| Spec | Feature | Status | Evidence |
|---|---|---|---|
| §6 | Black + gold identity | **Working** | `aura-gold`, #050505 bg, #f5b23c accent, now default |
| §11 | Golden AI sphere | **Working** | canvas provider; 12,926 lit samples measured |
| §94 | Nine agent states | **Working** | all nine measurably distinct in-browser |
| §12 | Sphere performance | **Working** | auto-tunes 1100 → 260 particles from real frame time |
| §17 | Task card | **Working** | command echo, plan, progress, cancel, artifacts |
| §19 | Plan UI | **Working** | numbered, ticks off as real steps complete |
| §64 | Task cancellation | **Working** | cooperative flag, honest "STOPPING…" |
| §73 | Artifact output | **Working** | OPEN button wired to the real path |
| §82 | Reduced motion | **Working** | freezes rotation, still renders |

### The rule that made the sphere worth building

**It is an instrument, not an ornament.** Every state transition comes from a
real subsystem event — `voice:stt-start` → listening, `ai:stream-start` →
thinking, a `trace:start` whose title mentions planning → planning, everything
else → executing, `trace:end{state:'fail'}` → error, and the device gateway →
connecting/connected. There is no timer and no random walk. If the sphere says
"executing", a tool is executing.

The same rule governs the task card: progress is the count of **real completed
trace steps** against the declared plan, capped below 100% until the task
genuinely ends. A bar that sits at 100% while work continues is the fake
progress the spec explicitly forbids, so `Trace.progress` cannot express it.
`Trace.end()` also downgrades `'ok'` to `'warn'` when the task was cancelled —
a cancelled task can never report success, whatever the caller passes.

### Bug found and fixed during the build

**The sphere rendered into a 1×1 canvas.** `init()` measured the container
before the browser had laid it out, got 0×0, and clamped it to 1px — then
nothing ever re-measured, because the manager only calls `resize()` on window
resize. The result was a one-pixel sphere stretched across a 974px stage,
visible as a faint arc. Fixed at the source with a `ResizeObserver`, plus
`resize()` now ignores a zero measurement instead of clamping it.

### Not built this round (honest list)

* **Website generation + developer mode** (§32/§33) — the largest remaining
  item. Needs a sandboxed project workspace and a dependency-install policy.
* **Discord bot** (§52) — needs a persistent gateway connection.
* **Auth / web portal** (§57) — AURA is currently single-user and local.
* **Update system** (§55) — no distribution channel yet.
* **Explicit prompt-injection defense** (§85) — web/file content is already
  passed as data rather than instructions, but there is no dedicated boundary
  test proving a malicious page cannot escalate. This should be next.
* **Smart home** (§34–39) — dropped by your decision; stays on Innovations.

---

## ⚪ Not Yet Implemented

Honest list of what does **not** exist.

> **Audited v0.20.** Six entries here had gone stale — they described things
> that were built in later rounds and never struck off. A list of limitations
> that is itself wrong is worse than no list, so they are marked ✅ **BUILT**
> with a pointer, rather than quietly deleted.

1. ✅ **BUILT** — ~~True web search~~. `websearch.py` (ddgs + trafilatura) reads
   results back through `serve.py`. See §Web Research.
2. ✅ **BUILT** — ~~Face recognition (identity)~~. 478-landmark signatures,
   enrolment with a live scan overlay, `_identifyAll()`. Never stores an image.
3. ~~**Smart-home control**~~ — **dropped from the roadmap by decision.** It would mean a different integration per ecosystem (Hue / Home Assistant / Matter) and derail progress on the assistant itself. Kept only as an idea on the hidden Innovations page.
4. **Photorealistic avatar** — the built-in body is a stylised procedural
   hologram, deliberately, so AURA stays 100% offline. *Partly addressed*: the
   Avatar Provider architecture now loads real VRM/GLB and Ready Player Me
   models with spring bones and MToon, if you supply one.
5. ✅ **BUILT** — ~~Typing / clicking automation~~. `automation.py` (pyautogui,
   FAILSAFE, hotkey blocklist, rolling arm TTL), plus dwell-to-click in v0.20.
   **Not installable in this sandbox** — no display — so it reports honestly.
6. **Custom voice cloning / neural TTS** — uses the OS voices only.
7. **Multi-user / cloud sync** — everything is local to one browser.
8. ✅ **BUILT** — ~~Image understanding by the LLM~~. `/look` and `/watch` send
   real frames to a vision model, chosen from Ollama's `/api/show` capabilities.
9. **Phoneme-accurate lip-sync** — see the Speech caveat above. Still amplitude-driven.
10. ✅ **BUILT** — ~~Persistent long-term memory~~. Semantic memory with
    embeddings + a Memory Center. No external vector DB; it is local and small.
11. **Offline speech recognition** — Chrome's Web Speech API sends audio to Google's servers; there is no local Whisper.
12. **Native desktop companion / browser extension** — AURA cannot see or click
    inside other applications except through a shared screen.
13. **Desktop clicking verified on real Windows** — the code path is complete
    and gated, but has never landed a click on a real Windows pixel from here.

---

## Full-body avatar — how it was built (DONE)

Being explicit rather than vague, since this is the outstanding request.

**Chosen: procedural rig** — keeps the 100%-offline guarantee you asked for. Ready Player Me was the alternative but requires a runtime CDN download.

| Step | Work |
|---|---|
| 1. Character | RPM avatar URL → `.glb` (~5 MB), rigged humanoid skeleton, ARKit blendshapes included |
| 2. Loader | `GLTFLoader` + `SkeletonUtils`; replace `Avatar3D`'s procedural head, keep the same `update(dt)` contract so **every existing system keeps working** |
| 3. Lip-sync | Map current 10 visemes → ARKit morphs (`viseme_aa`, `viseme_O`, `jawOpen`) — the viseme pipeline already exists and is tested |
| 4. Blink/emotion | `eyeBlinkLeft/Right`, `mouthSmile`, `browInnerUp` morphs — direct swap for the current pose targets |
| 5. Idle + gestures | Mixamo FBX clips (idle, wave, thumbs-up, nod) → `AnimationMixer` with cross-fade; bind to the existing `gesture:detected` events |
| 6. **Clothing/personalisation** | Outfits are separate skinned meshes sharing the skeleton. Swap = toggle mesh visibility + change material. Store choice in `config`. Colour/skin/hair via material uniforms |
| 7. AR body | In WebXR, scale the full body to ~1.6 m and anchor to a floor hit-test plane (current code anchors at +0.35 m for a head — needs a floor-plane change) |

**Estimated:** ~700 lines across a new `avatar/avatar-body.js` + `avatar/outfits.js`, plus a wardrobe panel.

**Trade-off you should decide:** RPM gives a realistic rigged human but needs a ~5 MB runtime download and an internet fetch (breaks the current 100%-offline guarantee). A procedural low-poly body stays offline and on-brand with the hologram aesthetic, but looks stylised, not realistic.

## Test Summary

```
tests/test-core.mjs        108 pass   math parser, units, intents, bus, store,
                                      plugins, memory, all 5 gesture classes
tests/test-providers.mjs    13 pass   6 provider adapters vs real wire formats
tests/test-actions.mjs      27 pass   desktop intent parsing, incl. 8 negatives
                                      that must NOT hijack normal chat
tests/test-setup.py         13 pass   setup wizard, Ollama proxy streaming, model
                                      install progress, camera+mic diagnostics
tests/test-live.mjs         22 pass   live-data intent routing + 10 negatives that
                                      must NOT hijack maths/units/self-questions
tests/test-body.py          22 pass   full-body rig, bone animation, gesture arm
                                      raises, wardrobe swap, glass UI, and REAL
                                      weather/crypto/FX/wiki/news API calls
tests/browser-test.py       70 pass   live Chromium: boot, wizard, chat, memory,
                                      streaming, stop/continue, 35 commands,
                                      MediaPipe, gestures→actions, avatar, AR,
                                      XSS, responsive
────────────────────────────────────────────────────────────────────
TOTAL                      275 pass   0 fail   0 console errors
```

### Bugs found by testing and fixed

1. **`%` parsed as percent instead of modulo** — `17 % 5` threw. Added operand lookahead.
2. **`[hidden]` defeated by CSS `display`** — the invisible settings backdrop was intercepting every click across the whole UI. Added `[hidden] { display: none !important; }`.
3. **Stream race condition** — sending a new message mid-stream let the old stream's teardown clobber the new message, interleaving two replies. Added `_settled()` await + monotonic stream IDs.
4. **MediaPipe 8× too slow** — GPU delegate under software rendering ran at 760 ms/frame. Added benchmark-driven CPU fallback and capability-aware frame pacing.
5. **Eyelids inverted** — half-disc geometry was flipped, so lids covered the eyes when open. Corrected theta ranges + fade-out at rest.
6. **Mouth rendered as two dashes** — a rotated capsule seamed apart. Rebuilt from scaled circle geometry with torus lips.
7. **Avatar cropped / scan line overhang** — camera framing ignored horizontal FOV. Added `_frameCamera()` fitting both axes; scan line now follows the head's elliptical chord.
8. **`file://` scheme filter bypass** — `open_url` prefixed `https://` *before* checking the scheme, turning `file:///etc/passwd` into `https://file:///etc/passwd` and slipping past the block. Scheme is now validated first.
9. **Bold markdown broke on inner `*`** — `**47 * 89 = 4,183**` rendered as literal asterisks. Rewrote the inline parser to extract code spans first, then allow lone `*` inside bold.
10. **Stage caption dumped command output** — `/apps` spilled a 13-item list across the screen. Caption now strips markdown and suppresses anything over 240 chars.
11. **Ollama unreachable from the browser (the big one)** — cross-origin preflight to :11434 was rejected by default installs. Now proxied same-origin through `serve.py`.
12. **Model install falsely reported "installed"** — prefix matching made `qwen2.5:1.5b` look present when only `qwen2.5:3b` existed. Now exact-match (or bare `:latest`).
13. **Mic failed silently in Chrome** — `SpeechRecognition` doesn't reliably trigger the permission prompt. Now calls `getUserMedia` first and surfaces the real error.
14. **Empty chat after skipping the wizard** — no greeting was emitted on that path. Greeting extracted to `greet()` and fired from every entry path.
15. **Wikipedia hijacked maths** — "what is 47*89" returned the **AK-47 article**. The wiki intent now rejects arithmetic, unit conversions and self-questions. Locked with 22 regression assertions.
16. **`file://` slipped past the fetch proxy** — scheme was checked after the `https://` prefix was added. Now validated first; SSRF to `127.0.0.1` also blocked.
17. **Body avatar clipped out of frame** — frame radius was tuned for the old head-only avatar. Recomputed for the taller figure across both FOV axes.
18. **Destructive actions bypassed confirmation (security)** — the guard compared `meta.confirmToken !== pending?.token`, which is `undefined !== undefined` → false when nothing was pending, so `close_app` ran unconfirmed. Now requires a non-empty token that matches a live pending entry.
19. **Legacy bridge path bypassed the permission system** — the older `parseActionIntent` route ran first and called the OS bridge directly. It now only runs when the desktop framework is unavailable.
20. **Router safety gap** — "format the c: drive" evaded the destructive-command filter because the regex required `c:` adjacent to the verb. Broadened, plus registry/boot/BIOS patterns added.
21. **Command center panels blank while hidden** — `requestAnimationFrame` doesn't fire reliably for offscreen work, so state transitions were lost. Added a synchronous `invalidate(true)` path for state changes.
22. **Questions triggered actions (significant)** — "how do I enable the camera" *turned the camera on*; "how do I open WhatsApp" *launched it*. The SYSTEM and TOOL router stages matched the verb without checking for interrogative phrasing. Both now bail on questions. 15 regression assertions added.
23. **Settings panes with no tab button** — CONNECT and DESKTOP panes existed but their buttons were never inserted, making both unreachable. Added, plus a test asserting every pane has a matching tab.


### Session 19 — bugs reported from real use on the user's Windows machine

24. **Ollama chat blocked every other request (the actual cause of "Cannot reach Ollama … (Failed to fetch)")** — `serve.py` used a single-threaded `socketserver.TCPServer`. One `/api/ollama/chat` held the *only* server thread for the whole generation (a cold model load is routinely 20-90s), so `/api/ollama/status`, `/api/metrics` and even static files queued behind it until the browser gave up and reported `TypeError: Failed to fetch` — which AURA displayed as "Ollama is not running". **Ollama was fine the entire time; AURA's own server was the bottleneck.** Fixed with `ThreadedHTTPServer` (`ThreadingMixIn`, `daemon_threads`). Proven by `tests/test-server-concurrency.py`: against the old server a status probe took **5003 ms** while a chat streamed; against the fixed server it returns in **<2 s** (measured ~2 ms).

25. **Hardcoded / misspelled Ollama model names** — `providers.js` shipped `defaultModel:'qwen2.5:3b'` and a `models[]` list; `ollama_proxy.py` shipped a `FAST_MODELS` catalog. On a machine without those exact tags AURA requested a model that did not exist, Ollama 404'd, and the failure was misreported as a connection problem. **All hardcoded names removed.** Discovery is now `/api/tags`-only.

26. **A wrong model name could reach Ollama** — a stale `ollamaSmallModel` in Settings was sent verbatim. Now validated against the installed list in three places: `pickOllamaModel()`, `ollama.stream()`, and finally `serve.py` itself.

27. **Voice feedback loop — "the app listens to what it says"** — the microphone stayed open while TTS played, so AURA transcribed its own speech through the speakers, `autoSendOnFinal` submitted it as a new question, and it answered itself forever. Fixed with three layers: **(a)** half-duplex — `main.js` stops recognition on `TTS_START` and resumes after `TTS_END`; **(b)** a hard gate dropping transcripts while `ttsSpeaking` plus a 700 ms tail for audio still leaving the speakers; **(c)** echo matching — a transcript with ≥60 % word overlap with what AURA just said is rejected. Suppression is logged, never silent. 16 assertions in `tests/test-voice-loop.mjs`.

28. **Speech-recognition restart storm** — `onend` unconditionally restarted recognition after 260 ms. With no usable microphone this became a hot loop that pinned the CPU and left the UI stuck on "LISTENING". Now uses exponential backoff (260 ms → 2.26 s) and gives up after 6 rapid ends with an actionable message.

29. **Ollama probe timeout too tight** — `ping()` aborted after 1800 ms and `status()` after 3 s. An Ollama busy loading a model into VRAM answers `/api/tags` more slowly than that, so a *running* Ollama was reported as absent. Raised to 6 s / 8 s.

30. **`ai:model-selected` had no listener** — the event was emitted but nothing consumed it, so a substituted model was applied silently. Now logged, and a correction raises a toast naming the model actually used.


### Session 20 — feedback after using the app

31. **"It lags a lot after running for a while" — FOUND AND MEASURED.** Two unbounded growth paths: the chat transcript was never trimmed from the DOM, and `Memory.messages` grew forever in RAM (only the *saved* copy was capped at 120). Measured in Chromium: DOM **1,214 → 7,299 nodes** and `avatar.update()` **0.033 ms → 0.077 ms/frame** after a load test. Fixed with a 220-node transcript cap (`maxTranscriptNodes`) and a 300-message RAM cap that preserves earlier topics for `summary()`. Re-measured: DOM growth cut from +6,085 to +1,165, frame cost **0.020 ms** — 3.8× faster than the leaked state. The avatar was never the problem.

32. **"The hologram doesn't wave back."** The avatar was innocent: firing `EV.GESTURE {gesture:'wave'}` always moved the arm (verified — `impulse.wave` 0.945, `upperArmR.rotation.x` animating). The break was `GestureStabilizer`, which required **5 consecutive frames** of the same gesture before emitting. That is correct for a *held* pose but wrong for a wave, which is temporal — `WaveDetector` reports it in bursts and is reset after firing. With a 2.2 s cooldown on top, a 5-second wave produced **one** event. Waves are now classified as transient: 1 frame to fire, 1.2 s cooldown, no "already active" suppression. Simulated 5-second wave: **1 → 4 events**, at slow/normal/fast speeds. Held poses still fire exactly once.

33. **"WebGL / WebXR always unavailable."** A reporting bug, not a capability one. The About page tested `avatarMode === '3d'`, but the default mode is `'body'` — also WebGL. It reported ✗ while the WebGL avatar was running. Now reports the real GPU capability and names the renderer. WebXR now explains *why* (no XR device / no WebXR API / insecure context) instead of implying breakage.

34. **File System plugin — implemented.** `list_directory`, `read_file`, `write_file`, `open_folder` now work through `bridge.py`. Path jail: every path is `realpath`-resolved **before** the containment check (so symlinks cannot escape), restricted to the home folder, with credential paths (`.ssh`, `.aws`, `.env`, `.netrc`…) refused outright. Writes are atomic (temp + `os.replace`) and require confirmation. 512 KB read cap, 2 MB write cap.

35. **Terminal plugin — implemented, with the security you asked for.** Your words: *"i dont want it resetting my c:d drive."* Three layers: (a) **29 destructive patterns hard-blocked** — `rm`, `del`, `format`, `diskpart`, `shutdown`, `reg`, PowerShell `Remove-Item` / `Set-ExecutionPolicy` — these cannot run *even with `confirmed=True`*; (b) shell metacharacters (`; & | > \` $`) rejected, so nothing can be chained onto a safe command; (c) everything runs as an argv array with `shell=False`, 20 s timeout, cwd jailed. Read-only commands run freely; anything else needs explicit confirmation. **The security test caught a real bypass**: `\bInvoke-Expression\b` never matched because `\b` does not sit between "e" and "-", so two PowerShell attacks were downgraded to "needs confirmation". Fixed and covered.

36. **Application launcher — custom apps + AI-reasoned fallback.** You can now add, edit, alias and remove applications from Settings → Desktop. For uninstalled apps AURA reasons about the best alternative instead of failing: the **offline System Core** answers instantly from a 40-entry web-equivalent table (WhatsApp → web.whatsapp.com, Spotify → open.spotify.com, Discord → discord.com/app), and only falls through to **Ollama** when it has no answer — so a slow local model never delays the common case. **The model can only ever propose a URL**, which is then validated: `javascript:`, `data:`, `file:` and credential-bearing URLs are all rejected, so a hallucinating model cannot cause an action.

37. **Gesture tab relocated** from the left dock to the top toolbar. `main.js` bound `.dock-btn[data-panel]`, so the moved button would have been dead — the selector is now `button[data-panel]`.

38. **Integrated GPU row hidden** in the system monitor (`showGpuMetric: false`), since it reports nothing useful.

39. **Hidden Innovations page.** 12 ideas, each stating honestly what already exists versus what would need building. No button anywhere, absent from `/help`; reached by typing `aura` or the hidden `/innovations` command. Required a `hidden` flag on plugin commands.


### Session 21 — avatar provider architecture + user-controlled policy

40. **Avatar Provider architecture.** The renderer is now pluggable behind an `AvatarProvider` interface, with a provider-independent `AnimationEngine` owning the whole performance (lip-sync, blink, emotions, idle motion, gesture reactions). Three providers ship: **Built-in** (default, offline, solid mesh), **VRM/GLB import**, and **Ready Player Me**. Adding a fourth means one file plus one registry line — nothing else in AURA changes. Proven by importing a real binary GLB built in-browser: its skeleton is retargeted, **it waves back**, and its ARKit morph targets lip-sync (peak influence 0.90).

41. **Solid-mesh built-in avatar.** The "glowing lines" were ~50%-transparent `MeshPhongMaterial` plus a wireframe overlay on every mesh — you saw the model's own backfaces through the front. Now opaque smooth-shaded `MeshStandardMaterial` with a three-point light rig; all 19 wireframe overlays hidden (`avatarSolid`, toggleable). The head carried its **own** separate wireframe cage, which is why the face still looked like a cage after the body went solid — now registered with the others.

42. **Terminal policy is a setting, not a hardcode.** Replaced the fixed blocklist with three user-selectable policies in Settings → Desktop: **ask** (default — read-only runs, anything harmful explains itself in plain English and requires confirmation), **strict** (destructive verbs refused outright), **open** (no prompts; requires typing CONFIRM to enable). Command chaining stays blocked under every policy — that is injection protection, not a preference. `explain_command()` turns a command into a consequence: *"ERASE A DISK — this destroys everything on the drive."*

43. **Real installed-application detection.** `detect_installed_apps()` scans Windows Start Menu shortcuts + uninstall registry keys, macOS `.app` bundles, or Linux `.desktop` entries. Everything comes back `approved: False` — detection grants nothing; you tick the apps AURA may launch.

44. **Lip-sync was silently dead under the provider system (found by test-body).** Three separate bugs, each hidden behind the next: (a) `renderPose()` wrote `mouth.h` directly, but `update()` damps current→target every frame and overwrote it; (b) after switching to targets, `_pose()` recomputed them from the resting emotion whenever `speaking` was false; (c) the mouth easing lives in `update()`, not `_pose()`, so calling `_pose()` alone set targets that nothing ever moved toward. Also fixed a **frame-rate-dependent viseme bug**: the queue only consumed entries whose `until` had passed, so on a throttled loop (headless, background tab, weak GPU) a viseme expired before it was ever applied. Now visemes have an explicit `start` and are applied when due — verified at both 60 fps and 16 fps.

45. **Compatibility surface for the manager.** `AvatarManager` exposes `bones`, `impulse`, `emotion`, `mouth`, `blink`, `speaking`, `garments`, `scene`, `camera` and `update()` so every existing caller — plugins, AR module, gesture bindings, tests — keeps working unchanged. `blink` is a live view onto the engine, so `blink.next = 0` still forces a blink. The FPS readout regressed when the manager published `avatarFps` instead of the `fps` key the HUD watches; caught by browser-test and fixed.


### Session 22 - Windows launch crash, echo loop, wardrobe

46. **AURA would not start on Windows at all.** `python serve.py --allow-actions` died with `UnicodeEncodeError: 'charmap' codec can't encode characters in position 2-63` before binding a port. Windows consoles default to **cp1252**, which has no box-drawing (`=`) or arrow (`->`) glyphs, and the banner printed them directly. Fixed at three levels: stdout/stderr are reconfigured to UTF-8 with `errors="replace"`; `UNICODE_OK` detects whether the console can render the fancy glyphs and `glyph()` falls back to ASCII if not; `say()` wraps every print so an encoding error can never kill the process. ANSI colour is disabled on non-TTY and enabled explicitly on Windows 10+ via `SetConsoleMode`. Proven by `test-windows-console.py`, which simulates a cp1252 stream that **refuses to be reconfigured** (worst case) and asserts the banner degrades to `========` with no crash.

47. **The echo loop was still open - it heard its own "Hello Commander".** The previous guard stopped recognition on TTS_START, but `SpeechRecognition.stop()` is **asynchronous**: Chrome still fires `onresult` for audio it had already buffered, and those late results arrived after `ttsSpeaking` had been cleared. Two further holes: the guard lived in `main.js`, so TTS triggered anywhere else (gesture greeting, wake-word reply, plugin) bypassed it entirely; and interim results were not gated, so the caption still flickered with echoed text. Fixed by moving half-duplex into `SpeechInput` itself, which now subscribes to TTS_START/END/INTERRUPT directly. A synchronous `muted` flag is set **before** stopping, `abort()` is used instead of `stop()` (it discards the buffer), and unmute waits out a 900 ms acoustic tail. 14 new assertions, including "late buffered result is dropped while muted".

48. **Speech-service network errors spammed toasts.** Chrome's recogniser is cloud-backed and drops out constantly on a flaky link, and each drop raised a warning toast. Now the first is shown and repeats are marked `quiet` - logged, not toasted - and never fatal.

49. **Avatar wardrobe: body type, hairstyle, hair colour.** 6 body presets (neutral / masculine / feminine / athletic / slim / sturdy), 10 procedural hairstyles (buzz, short, swept, bob, long, ponytail, bun, mohawk, afro, none) and 11 hair colours including "match theme", which tracks the palette. Body presets **scale existing bones** rather than swapping meshes, so every animation keeps working with no retargeting - verified by a test that fully customises the avatar and then checks it still waves (arm 0.009 -> -1.465). All procedural geometry: no downloads, fully offline.


### Session 23 - theming engine, memory center, system merge, spring bones

50. **Expanded UI theming.** A real engine in `js/ui/theming.js`, not a list of stylesheets: 10 colour presets (including a light theme), 6 background treatments, 4 HUD styles, 3 density presets, 8 live-tuned sliders (accent hue rotation, glass blur, panel opacity, glow, corner radius, text size, animation speed, background depth), custom accent colour pickers, and 7 toggleable widgets. Everything writes CSS custom properties on `<html>`, so one variable restyles the interface **and** the WebGL scene in the same frame - the avatar's ground ring and the particle field already read `--accent`. `resolveTheme()` is pure (config in, variables out), which is how every preset is unit-tested without a DOM. Values are clamped, so a corrupt config cannot produce an unusable UI. A blanket `* { transition-duration: ... !important }` was the obvious way to implement animation speed and the wrong one - it would have flattened every tuned transition in the app - so only decorative loops are scaled.

51. **Memory Center (ChatGPT-style).** Settings -> MEMORY: four tabs (conversation, pinned, facts, knowledge), full-text search, inline editing, per-message delete, and **pinning**. A pinned message is exempt from trimming and always included in `window()`, so "remember this" is durable - verified by pinning a message, pushing 1,400 more through the session, and confirming the pinned text still reaches the model. Also: teach AURA a fact (stored as knowledge and recalled automatically when relevant), export everything to a text file, clear the chat, or forget everything. `ConversationMemory` and `Memory` gained `idOf/find/remove/edit/pin/search`; ids derive from the creation timestamp because array positions shift the moment trimming runs.

52. **OPS and SYSTEM merged into one System Center.** They overlapped: OPS was live telemetry, SYSTEM was diagnostics and the event log - two dock buttons for one job. Now a single panel with both, and every element id preserved (`sys-readout`, `event-log`, `btn-selftest`), so `renderSysReadout()` and the log needed no changes. `openPanel('system')` is aliased to `'ops'` so plugins, tests and habit all keep working.

53. **VRM spring-bone physics.** `js/avatar/spring-bones.js` gives imported avatars real secondary motion for hair, skirts and tails. Verlet integration with a hard length constraint (so bones can never stretch), stiffness pulling back to rest, gravity, drag, and sphere colliders so hair does not sink into the head. Reads the VRM extension when present - `VRMC_springBone` (1.0) or `VRM.secondaryAnimation` (0.x, including the spec's real `stiffiness` typo) - and falls back to name-based chain detection so a plain GLB gets physics too. **Fixed 60 Hz timestep**: a variable dt makes verlet springs explode on a stutter, which would look like the hair detonating; verified by driving five consecutive 2-second frames and asserting every joint stays finite. Proven to actually move: firing a wave displaces the hair tip by 0.0083 units.


### Session 24 - Windows runtime errors + MToon

54. **`ConnectionAbortedError` traceback on Windows.** `[WinError 10053]` printed a full traceback whenever the browser walked away mid-response - a tab reload during an in-flight `/api/ollama/status`. `handle_error()` filtered `BrokenPipeError` and `ConnectionResetError` but not the **Windows-specific** `ConnectionAbortedError`, and `_json()` had no guard at all. Both fixed; `TimeoutError` covered too. Proven by abandoning 30 connections mid-response and asserting zero tracebacks while the server keeps serving.

55. **`ACTION get_policy` spam loop.** The console filled with `get_policy` forever. `renderDesktop()` called `renderTerminalPolicy()`, which performs a desktop **action**, and `renderDesktop` was itself bound to `desktop:action-executed` - a self-feeding loop. The policy is now cached (`_policyCache`), concurrent fetches are coalesced (`_policyPending`), and desktop redraws are debounced and skipped entirely when the pane is not visible. Measured in a real browser: **1 call at boot, still 1 after 25 action events and 5 s idle** - previously unbounded.

56. **MToon cel-shading implemented.** Previously flagged as missing: a VRM rendered with standard PBR shading rather than its authored flat anime look. `js/avatar/mtoon.js` now converts materials to real toon shading - banded diffuse with a controllable shade colour, Fresnel rim light, and inverted-hull outlines - reading parameters from `VRMC_materials_mtoon` (VRM 1.0) or `VRM.materialProperties` (VRM 0.x). Toggleable and **lossless**: turning it off restores the original PBR materials rather than approximating them. A plain GLB is never silently restyled (`source: 'not-a-vrm'`) but toon can be forced. Still out of scope: MToon UV-animation, matcap spheres, multiply-blend shading textures.

57. **Tested against real VRM files.** The previous flag was that spring bones were only tested against a hand-built GLB. `test-vrm-mtoon.py` now constructs genuine **VRM 1.0 and VRM 0.x** files in-browser - real `VRMC_vrm` / `VRMC_springBone` / `VRMC_materials_mtoon` blocks, and the legacy `VRM.secondaryAnimation` / `materialProperties` equivalents - by splicing extension JSON into an exported GLB and re-packing the container. Both import through the real code path: spring source reports `vrm1` / `vrm0`, the declared collider is honoured, shade colour and `shadingToony` come from the file, and the hair swings (0.0139 displacement). **A bug this caught in my own code:** outline shells were parented to the mesh they outline, so `traverse()` walked into them and recursed until "Maximum call stack size exceeded". They are siblings now.


### Session 25 - web research, face recognition, input automation

58. **True web search - implemented.** Previously `/search` could only open a tab; AURA had no way to read results. Now `websearch.py` runs the pipeline you sketched: **ddgs** (no API key, no tracking) for results, then **trafilatura** to pull clean article text out of the HTML, then the local Ollama model reasons over it and cites sources as `[1]`, `[2]`. Verified live: 4,925 clean characters from a Wikipedia page in under a second; a full research call read 2 real pages and produced 4,647 characters of model-ready context in 2.4 s. **Adaptive depth** keeps it fast - "capital of france" uses snippets only, "explain how ollama works" reads the pages. I used trafilatura rather than crawl4ai deliberately: crawl4ai drives a headless Chromium (~300 MB install, a browser process per crawl), which contradicts AURA starting instantly on a modest machine. Both dependencies are optional; without them AURA falls back to opening a tab and says exactly which package is missing.

59. **Face recognition (identity) - implemented.** Face *detection* and *expression* already worked; recognising **who** someone is now does too. The signature is derived from the **478 MediaPipe face landmarks AURA already computes** - 25 inter-landmark distance ratios normalised by interocular distance - so there is **no extra model download and no second inference pass**. Enrol by name (4 samples, angled poses rejected), and AURA greets you when you appear. **Privacy: it stores an array of floats, never an image** - asserted in the test by regex-scanning localStorage for image data. ~1.2 KB for two people. **Two real bugs the tests caught:** (a) plain cosine similarity is useless here because all human faces score ~0.97 against each other - the useful signal sat in the last two decimals; replaced with a magnitude-weighted relative deviation that separates same-person (0.92) from different-person (0.00). (b) That metric then failed on scale changes because near-zero features amplified fixed landmark jitter into huge *relative* errors; weighting each feature by its own magnitude fixed it, and the same face now matches at 0.92 whether close or far. Stated limits: geometric not deep-learned, good for a household, identical twins will collide, and it must never gate anything sensitive.

60. **Input automation - implemented.** `automation.py` gives AURA real mouse and keyboard control via pyautogui. This is the most dangerous code in the project, so the safety model is layered and enforced **server-side**, never in the browser the AI can influence: off by default and must be **armed**; pyautogui's **FAILSAFE stays on** (slam the pointer into the top-left corner to abort instantly); a 40-step budget with no loops; typed text is data and cannot contain key combinations; a **hotkey blocklist** that refuses Alt+F4, Ctrl+Alt+Del, Win+R, Win+L and friends *even when confirmed*; every plan is described in plain English before it runs; and arming lapses after 15 minutes. **A real bug the test caught:** `_clamp_point()` returned raw coordinates when pyautogui was absent, so a plan built on a headless machine could carry negative coordinates into a later run on a real one. It now always clamps, and never to (0,0) - that corner must stay free for the failsafe.

61. **`requirements.txt` added.** All four optional dependencies documented with what each unlocks. AURA still runs with none of them; `serve.py` needs only the standard library.


### Session 26 - autonomous upgrade pass

62. **Image understanding by the LLM - implemented.** Previously the camera described the scene in TEXT and handed that to the model. Now the raw frame goes too: `ollama.stream()` accepts an `images` array, strips the data-url prefix, and attaches it to the last user message where Ollama expects it. `/look [question]` captures the current frame and asks a multimodal model about it. Routing is explicit - when images are present AURA picks a **vision-capable** model rather than letting the speed-first router choose a text model that would silently ignore the picture. With no vision model installed it says so and suggests `ollama pull moondream` instead of pretending. **Verified end-to-end in a real browser** against a fake Ollama: camera on, 36 KB frame captured, model confirmed receiving 1 image.

63. **Persistent semantic memory - implemented.** `VectorStore` embedded nothing; recall was keyword overlap, so "how do I make the assistant faster" could not find a note about "reducing model latency". It now discovers an embedding model in Ollama (nomic-embed-text, mxbai, all-minilm...), embeds documents through `/api/ollama/embeddings`, and searches by cosine similarity - with an embedding cache so identical text is never embedded twice. **Falls back to the original keyword search when no embedding model exists, and `kind` reports which backend is actually in use** - it never claims semantic search it isn't doing. Verified: the latency note is retrieved for a query sharing zero keywords with it.

64. **Two real bugs found while testing the above.** (a) `PluginRegistry.run()` ran every command's return value through `JSON.stringify`, so a command returning `null` to mean "I already streamed my reply" printed the literal string **"null"** in the chat - visible with `/look`, and latent in `/search`. (b) The engine then rendered that same null. Both fixed at source, with 4 regression assertions in `test-core`.

65. **Smart-home control dropped from the roadmap** by decision - a separate integration per ecosystem (Hue / Home Assistant / Matter) for no progress on the assistant itself. It survives as an idea on the hidden Innovations page, reframed around presence sensing rather than switch flipping.

66. **Project organisation.** Added `PROJECT_MAP.md` (a one-page index - every path in it is verified to exist) and `.gitignore`. Removed 3 MB of `tests/*.png` debug artifacts that are regenerated on every run. The Innovations page now marks the two ideas that shipped instead of still listing them as future work.

67. **Vision capability was guessed from the model NAME — the gemma4 bug.**
    `ollama.isVisionModel()` tested the model name against a fixed regex of
    known multimodal families. The pattern knew `gemma3` but not `gemma4`,
    so a user holding **`gemma4:12b` — a fully multimodal model — was told
    "none of your Ollama models can see images" and advised to pull one.**
    They pulled `qwen2.5vl:7b` that they did not need.

    This class of bug is unfixable by extending the pattern; the next model
    family breaks it again. Ollama's `/api/show` returns a `capabilities`
    array (`["completion","vision","tools","thinking"]`) derived from the
    model's own GGUF metadata. That is ground truth, and it is now what
    AURA uses.

    - `ollama_proxy.show()` / `capabilities()` query `/api/show`, cached on
      `(name, modified_at)` so re-pulling a model invalidates its entry.
      Probed concurrently (max 6 workers) during `status()`; a failure there
      is non-fatal and leaves `caps: []`.
    - `/api/ollama/status` now returns per-model `caps` plus ready-made
      `vision` / `embedding` / `tools` / `thinking` rosters.
    - `ollama.isVisionModel()` reads reported capabilities first and only
      falls back to a name guess when Ollama did not report any (< v0.6.0).
      `capsAreReal()` says which of the two answered.
    - `profileModel()` lets reported capabilities **override** inference in
      both directions - a vision-looking name reported text-only loses the
      capability.
    - The name fallback was rewritten to be generic (`-vl`, `vision`,
      `multimodal`, `-mm`, `gemma>=3`, `llama4`) instead of a fixed family
      list, so it degrades sensibly on an old Ollama.
    - The "no vision model" message now states whether it is a verified fact
      or an unverified guess, lists the unverified models, and points at
      `/pin vision <model>` rather than assuming a download is required.

    Verified: 21 assertions in `tests/test-capabilities.py` (modern Ollama,
    legacy Ollama with no capabilities field, and Ollama down), plus a real
    browser run in `tests/test-vision-capabilities.py`.

68. **`/look` picked the slowest vision model available.** The selection was
    `ollama.visionModels()[0]` - the first name **alphabetically**, from a
    list the proxy sorts. On a machine holding `gemma3:12b`, `gemma4:12b`
    and `qwen2.5vl:7b` it always chose `gemma3:12b`, one of the two heaviest
    options, while a 7B model sat unused. Slowest-by-accident on a machine
    whose owner explicitly asked for speed-first routing.

    Replaced with `AIEngine.pickVisionModel()`: an explicit `/pin vision`
    wins, else the registry's VISION task selection (which honours the
    speed-first strategy and measured throughput), else the smallest vision
    model by parameter count. The size ceiling is deliberately **not**
    applied - if the only model that can see is a 12B, refusing to use it
    would mean refusing to answer at all.

    Measured on the reference 8-model configuration: was `gemma3:12b`, now
    `qwen2.5vl:7b`. The chosen model and the reason are emitted on
    `ai:model-selected` and shown in `/models`.

69. **`/models` could not tell you which models can see.** It listed tiers,
    task routing and exclusions but never answered "can anything here read
    an image?" - the exact question that led to the unnecessary download.
    It now has an **Image understanding** section listing every
    vision-capable model, marking each as *confirmed by Ollama* or
    *guessed from the name - unverified*, and naming the model `/look`
    will actually use.

70. **Input automation had an engine and a panel, but no steering wheel.**
    `automation.py` (validation, arming, kill-switch, hotkey blocklist,
    step budget) was complete and tested. `local-actions.js` exposed
    `automationDryRun()` / `automationRun()`. Settings → Desktop → Input
    Automation had working ARM / DISARM / WHERE IS MY CURSOR buttons.

    **Nothing called `automationRun()`.** Grepping the entire `js/` tree for
    `automationRun|automation_run` outside `local-actions.js` returned
    nothing. A user could install pyautogui, arm automation, watch the badge
    turn ARMED — and then have no way to make AURA click or type anything.
    The capability was reachable only from a devtools console.

    This is exactly the failure mode the project's own rules forbid: a
    control that appears functional but leads nowhere. Fixed by adding the
    missing commands to the desktop plugin:

    | Command | Does |
    |---|---|
    | `/automation [arm\|disarm\|status]` | Check, arm, or disarm |
    | `/cursor` | Report the live pointer coordinate |
    | `/click <x> <y> [right\|double]` | Real mouse click |
    | `/type <text>` | Type into the focused window |
    | `/hotkey <combo>` | e.g. `ctrl+s` (blocklist still enforced) |
    | `/press <key>` | Single key |
    | `/scroll <n>` | Scroll up (+) / down (-) |

    Every one routes through a shared `runPlan()` helper that **dry-runs
    first**, refuses if not armed (naming the fix), shows the plain-English
    plan, and only then executes with `confirmed=true`. No safety layer was
    weakened - the server still independently requires armed + valid +
    confirmed, so a compromised page cannot skip the check.

    Verified: 17 assertions in `tests/test-automation-ui.py`, run
    deliberately **without pyautogui installed** to prove AURA reports the
    limitation honestly (`pip install pyautogui`) rather than pretending.
    `alt+f4` is still rejected before reaching the mouse.

    **Still true and worth stating:** `/click` needs absolute screen
    coordinates. AURA cannot yet *see* the screen and decide where to click
    on its own - that needs the screenshot piped to a vision model, which is
    the natural next step now that `/look` and capability detection work.

71. **Command palette — `/` and `@` now show what you can actually run.**
    Commands were only discoverable via `/help`, which meant memorising 67 of
    them. Typing `/` or `@` in the composer now opens a live filtered list
    built from `plugins.listCommands()` — so a plugin registered tomorrow
    appears with no change to the palette. Arrow keys move, Tab completes,
    Esc dismisses. `js/ui/command-palette.js`.

    Only fires when the token is at the START of the input, so `3 / 4` and
    `me@example.com` never trigger it.

    **Bug caught by `test-guide` during this work:** the first build
    intercepted Enter unconditionally, so typing a COMPLETE command
    (`/guide`, `/models`) autocompleted the thing you had already typed
    instead of sending it — the message was silently eaten and two guide
    tests went red. Enter now only intercepts when it would genuinely change
    the text; Tab always completes. Regression assertion added.

72. **Screen awareness — Copilot-Vision-style, honestly built.**
    `js/vision/screen-share.js` + `js/ai/screen-agent.js` + `js/plugins/screen.js`.

    | Command | Does |
    |---|---|
    | `/watch` | Share a tab, window or whole screen (browser picker) |
    | `/watch ask <q>` | Answer a question about what is shared |
    | `/watch status` | What is shared, which model reads it, is clicking possible |
    | `/screenmode auto\|ocr\|vision` | How the screen gets read |
    | `/find <text>` | Locate an element, park the pointer on it |
    | `/do <instruction>` | Plan an ordered set of UI actions, preview, confirm |

    **Why not a floating overlay:** a page on localhost cannot draw over other
    applications — only a native process can. Rather than fake it, AURA uses
    `getDisplayMedia`, where the BROWSER shows the picker, the user chooses
    the surface, and a persistent sharing indicator stays visible. Keep AURA
    on a second monitor and share the app you are working in.

    **Two-stage OCR pipeline (the user's own idea, and it is the right one).**
    `screenMode: 'ocr'` sends the frame to the smallest installed image→text
    model (moondream 1.7B ▸ smolvlm 2B ▸ granite-vision 2B ▸ …), takes only
    the text, and hands that to the fast chat model. Most screen questions
    are text questions, so a 1.7B read plus a 2B answer beats one 12B
    multimodal pass. `'auto'` routes per question: colour/layout/icon
    questions go to full vision, everything else takes the cheap path.
    Model candidates are regexes matched against the REAL installed list.

    **Frame rate: 1 fps requested, pull-based.** A screen is nearly static, so
    capturing at 30 fps would burn CPU for nothing. Frames are only grabbed
    when something asks. Watch mode adds a 16×16 luma perceptual hash and only
    emits `screen:changed` when ≥6% of cells differ — an idle screen costs
    almost nothing. Frames are JPEG at 0.82 downscaled to ≤1280px (a raw
    screenshot PNG is 2–4 MB; this is ~12 KB, measured).

    **How AURA decides WHERE to click — the honest answer.** Language models
    are bad at pixel coordinates; asking for raw x/y produces confident wrong
    numbers. So AURA never asks. The frame is overlaid with a labelled 12×8
    grid, the model names a CELL ("C4"), and AURA computes the cell centre
    itself. Naming a cell is a far easier discrimination than a pixel, and the
    arithmetic is ours, not the model's. Accuracy is deliberately reported as
    **coarse**, `/find` moves the pointer WITHOUT clicking so the target can be
    verified, and `/do` shows every resolved coordinate before executing.

    **Refuses rather than guessing:** coordinates are only mapped when an
    ENTIRE MONITOR is shared. A window or tab capture has no fixed
    relationship to desktop pixels, so `/find` and `/do` decline and explain
    how to fix it, instead of clicking somewhere wrong.

    Verified: 58 assertions in `tests/test-screen-agent.mjs` (model choice,
    mode routing, grid maths, coordinate mapping, plan-JSON extraction from
    messy replies, intent→step resolution) and 40 in `tests/test-screen-ui.py`
    in a real browser with a synthetic capture surface — 12,703-byte JPEG
    grabbed, moondream chosen over gemma4:12b, transcription returned, the
    2B chat model answered, static-screen change score 0.

    **Not verified on real hardware:** the sandbox has no real desktop and no
    real Ollama. Grid-cell accuracy against actual applications is unmeasured
    — expect to iterate on `GRID_COLS`/`GRID_ROWS`.

73. **`/watch` had no cursor — reported as a failure, and it was one.**
    `/watch` was read-only. Only `/find` moved anything, and it moved the
    **real OS pointer**, which fights the user for their own mouse — the user
    reported "i dont think it moved the cursor as i was controlling it".
    Worse, `/find` bailed out entirely unless an entire monitor was shared,
    so on a tab or window share nothing happened at all.

    Fixed with `js/vision/screen-cursor.js` — AURA's **own** soft reticle,
    drawn on the shared-screen preview:
    - Lives in capture-space, so it works on a tab, a window OR a full screen.
    - Never touches the real mouse. You keep control at all times.
    - Two rings, a crosshair and a label, plus a fading trail so a multi-step
      plan stays legible after the fact.
    - `locate()` no longer refuses on a window share. It finds the target and
      reports `clickable: false` with the reason, instead of doing nothing.
    - New `/here [click|doubleclick|rightclick]` promotes the reticle to a
      real click — still armed + confirmed, still monitor-only.

74. **Automation expired after 15 minutes of *wall clock*, not idle time.**
    User: "/automation kept timing out after 15 minutes". `ARM_TTL` was a flat
    900s and only successful actions refreshed it, so arming and then reading
    a document for 20 minutes silently disarmed it.
    - `ARM_TTL` is now **3600s**, and it is a genuine rolling idle window:
      `is_armed(touch=True)` refreshes it, and the UI's capability poll counts
      as activity while the tab is open.
    - `arm_remaining()` reports the real number, surfaced in `/automation`.
    - Expiry is *recorded*, so the refusal says "expired after N minutes idle"
      rather than the generic "not armed".
    - Measured: at 50 idle minutes the window went **599s → 3599s** on a poll.

75. **No way to see what AURA was doing — now there is.**
    User: "there should be an way for me trace wht the APP is doing... like
    everything in front of me." `/watch` and `/do` were black boxes; when they
    misbehaved nothing showed which stage failed.
    `js/core/trace.js` + `js/ui/trace-view.js` add an append-only, live
    activity log rendered in the new **SCREEN** panel. A real `/find` produces:
    ```
    /find Save                                        127ms
      Capture frame     15ms   1280x720, 14 KB
      Choose reader      0ms   moondream — small image→text model
      Overlay grid      24ms   12x8 labelled cells
      Model replied     88ms   C4
      Resolve cell       0ms   C4 → frame (267, 315)
      Map to desktop     0ms   screen (400, 473)
      found at cell C4
    ```
    Steps stream as they happen, so a slow stage looks slow instead of hung.

76. **New SCREEN panel.** Live preview of the shared surface at 4 fps with
    AURA's reticle composited on top, what-is-shared readout, whether clicking
    is available, quick ASK/FIND buttons, and the activity trace.

77. **New gestures — swipes and a settings sign.**
    | Gesture | Action |
    |---|---|
    | 🤟 Three fingers | Open Settings |
    | 👉 Swipe right | Next panel |
    | 👈 Swipe left | Previous panel |
    | 👆 Swipe up | Volume up |
    | 👇 Swipe down | Halt speech/generation, close modals |

    **The hard part was not detecting a swipe — it was not confusing it with a
    wave.** Both use an open hand and the same wrist signal. `SwipeDetector`
    separates them geometrically: a swipe is fast, long and **straight**
    (net displacement / path length > 0.75); a wave oscillates, so its path
    length is huge while net displacement is ~0. Asserted directly: a
    40-frame simulated wave fires the wave detector and **never** fires a
    swipe. Diagonals within 1.4× on both axes fire nothing rather than
    guessing an axis. 900 ms cooldown stops one flick becoming a burst.

    Panel cycling skips the hidden innovations page, so a swipe can never
    reveal it. All existing bindings — including the rock sign the user uses
    daily — are unchanged and asserted.

    Verified: 57 assertions in `tests/test-gestures-cursor.mjs`, 31 in
    `tests/test-screen-panel.py` (real browser).

    **Not verified on real hardware:** swipe thresholds are tuned against
    synthetic motion. Real hands may need `minDistance`/`minSpeed` adjusted in
    `js/vision/gesture-classifier.js`.

78. **Recommending moondream was a mistake, and it broke two things.**
    I told the user to `ollama pull moondream` without ever running the screen
    pipeline against it. Their logs, verbatim:
    ```
    Read screen  28885ms   moondream:latest → 23 chars in 28849ms
    Read screen  40041ms   moondream:latest → 0 chars in 40003ms
    Planner replied 7629ms (empty)
    Could not parse a plan from the model. It said:
    ```
    Four `/do` attempts, 36-47 seconds each, zero useful output.

    **Two separate bugs, both mine:**

    (a) **A 1.7B captioner became the CHAT model.** `autoEligible()` ranked
    purely on size under the speed-first strategy, so the smallest installed
    model won — and moondream was smallest. It cannot follow instructions or
    emit JSON. `ModelRegistry._isCaptionOnly()` now excludes vision models
    under 3B (and the known caption families) from auto-routing, with the
    reason surfaced in `/models`: *"image captioner — reads pictures, cannot
    hold a conversation or plan"*. Verified: chat went back to `gemma2:2b`.

    (b) **`OCR_CANDIDATES` was ordered smallest-first.** That was the wrong
    objective — a fast answer containing nothing is worthless. Reordered by
    OCR quality (`qwen-vl` → `minicpm-v` → `granite-vision` → … → moondream
    last). `WEAK_READERS` flags caption-only models so `/watch status` warns
    when one is all that is installed, quoting the real measurement.

79. **`/do` now plans directly from the image — the user's suggestion.**
    The old chain was image → OCR → text → chat model → JSON. That discarded
    all layout information and, with a weak OCR stage, gave the planner an
    empty string to work from.

    `plan()` now sends the **gridded screenshot itself** to a model that can
    both see and write structured output (`pickPlannerModel()` — multimodal,
    ≥3B, captioners excluded), and asks for JSON steps where each click
    carries its grid cell. One model call instead of two, no lossy text
    bottleneck, and the model can see layout — which is what a UI task
    actually depends on.

    `resolve()` reuses the cell the planner already returned via the new
    `cellToPoint()` (pure arithmetic, no model), instead of re-running
    `locate()` per click. On the user's machine that removed a ~30s model
    pass **per step**. Asserted: `locate()` is called 0 times when the
    planner supplies cells.

    Verified in a real browser: planner `gemma4:12b`, intents
    `[{click Send, cell C4}, {type hello}]`, resolved to screen (400, 473),
    narration correct. If the planner returns nothing the message says so and
    names a model that would work, instead of "Could not parse a plan".

80. **Avatar height control.** WARDROBE → HEIGHT: a live slider (60%–160%)
    plus Short/Default/Tall presets. Scales Y on the provider's root with
    partial lateral compensation, so the avatar gets taller rather than
    merely bigger. Works on the built-in avatar and on imported GLB/VRM
    (bones, skinning and spring bones follow, being children of the root).
    Persisted in `config.avatarHeight` and reapplied on boot.

    **Bug caught by looking at the screenshot:** at 1.4× the head was cut off
    — `_frameCamera()` used a fixed `frameRadius` that ignored scale. It now
    multiplies by the root's Y scale and lifts the centre proportionally.
    Confirmed visually at 0.7× and 1.4×.

81. **`AbortError: BodyStreamBuffer was aborted` on every Stop.**
    Reported from the real console at `engine.js:586` and `engine.js:1007`.
    `ndJson()` and the SSE reader both ended with:
    ```js
    } finally { try { reader.cancel(); } catch {} }
    ```
    `reader.cancel()` returns a **Promise**. When the body has already been
    aborted that promise REJECTS, and `try/catch` only catches synchronous
    throws — so the rejection escaped as an unhandled promise rejection and
    printed a hard error every time the user pressed Stop or sent a new
    message over an in-flight one. Now `.catch(() => {})` is attached.
    Verified in-browser: two superseded streams plus an explicit Stop produce
    **zero** `unhandledrejection` events.

82. **`/do` never worked, and the reason was JSON parsing.**
    The user ran it four times and got "Could not parse a plan" every time.
    I had only ever tested against a stub that returned pristine JSON.

    Measured against realistic 7B replies, the original parser handled
    **2 of 5**. Real models emit markdown fences, prose wrappers, single
    quotes, trailing commas, unquoted keys, `True`/`None`, smart quotes — or
    answer in plain English and never produce JSON at all.

    `extractJson()` rewritten as a three-stage cascade:
    1. Strict parse of the first *brace-balanced* block (string-aware, so
       braces inside strings no longer break it).
    2. `repairJson()` — single→double quotes, unquoted keys, trailing commas,
       Python literals, smart quotes.
    3. `salvageFromProse()` — reads intent out of English:
       *"click the X in the top right corner (cell L1)"* becomes a real step.

    Now handles **9 of 9** realistic shapes, and still returns `null` for a
    genuine refusal so that stays distinguishable from a parse failure.
    `tests/fake-real-ollama.py` cycles through the messy shapes on purpose —
    a stub that always returns clean JSON is what hid this bug.

83. **`/do close the open window` now just works, with no model at all.**
    Closing a window is Ctrl+W on every desktop. Spending 40s asking a 7B
    model to find an X button — and getting it wrong — is worse than knowing.
    `ScreenAgent.SHORTCUTS` handles close / save / undo / copy / paste /
    select-all / switch-window / new-tab / reload / find, short-circuiting
    before any model call **and before the screen-share check**, since none
    of them need to see anything. Measured end-to-end: **20 ms**, versus
    36–47 s of failure previously. Alt+F4 is deliberately never used — it is
    on the permanent blocklist; Ctrl+W closes a tab/document instead.

84. **Two-stage describe→plan pipeline, as the user specified.**
    *"one for moondream in which it first describes the image ... then the ai
    core creates the procedure"*. Implemented as `planTwoStage()`:
    stage 1 a vision model only has to DESCRIBE (even a 1.7B captioner
    manages that), stage 2 a proper text model turns that description plus
    the instruction into steps.

    It is a **fallback**, entered automatically when (a) no installed vision
    model is strong enough to plan, or (b) single-stage planning returned
    nothing. Verified in-browser on a simulated moondream-only machine:
    moondream described, `gemma2:2b` planned, plan produced. If the describer
    returns under 15 characters it says so and names a model that works,
    rather than failing silently.

    **Verified end to end for real** — `tests/test-do-e2e.py`, browser →
    server → pyautogui with keystrokes actually dispatched:
    ```
    ✓ /do close the open window SUCCEEDS   ✅ Completed 1 step(s). 1. Press CTRL+W   20ms
    ✓ /do save the file SUCCEEDS           ✅ Completed 1 step(s). 1. Press CTRL+S
    ✓ /do click the close button           ✅ Click "Close" — cell L1, screen (1840, 68)
    ```
    Server log confirms three `ACTION automation_run -> Completed 1 step(s)`.

85. **`/task` — multi-step agent loop. The real escalation.**
    The user's example: *"/do open whatsapp and message Fiona Harris, the
    message is Hi"*. `/do` structurally cannot do this — it looks at the
    screen once and emits a plan, but at the moment you ask, WhatsApp is not
    on screen. There is nothing to plan against.

    `js/ai/task-agent.js` implements **observe → decide ONE action → act →
    observe again**. Each iteration takes a fresh screenshot, so the agent
    sees the consequence of what it just did. That is what lets it open an
    app, wait for it, find a search box, type a name, pick a result, find the
    message field and type — none of it scripted in advance.

    Actions: `open_app`, `click`, `type`, `hotkey`, `press`, `scroll`, `wait`,
    `observe`, `done`, `fail`. Deliberately small; `run_command` and `delete`
    are **not** available and that is asserted.

    **New `running_apps` bridge action** (psutil) so the agent can know what
    is already open instead of inferring it from a screenshot — faster and
    far more reliable.

    **Safety, none of it weakened:**
    - Hard ceiling of **14** iterations, overriding any caller budget.
    - Every action previewed and individually confirmed; declining aborts the
      whole task and executes nothing.
    - The agent must declare `done` or `fail`; it cannot spin silently.
    - Clicking without a shared screen is refused as fatal, not guessed.
    - A *non-fatal* step failure is fed back into the loop rather than
      aborting — that feedback is the entire point of a loop.

    **`normaliseAction()`** absorbs how small models really phrase things:
    `do`/`type`/`step` instead of `action`, wrapped in `steps[]` or
    `actions[]`, aliases (`open`/`launch`, `tap`, `write`, `shortcut`,
    `finish`, `give_up`), `"c 4"` → `"C4"`. A click with no cell is rejected
    outright, because it is unclickable.

    **Verified end to end in a browser** (`tests/test-task-e2e.py`), browser →
    agent loop → server → pyautogui with keystrokes dispatched, against a stub
    that returns deliberately messy JSON:
    ```
    1. Open whatsapp              → Opened WhatsApp via deep link
    2. Click "search box" (B2)    → clicked at (240, 203)
    3. Type "Fiona Harris"        → ok
    4. Click "Fiona Harris" (B4)  → clicked
    5. Click "message box" (F8)   → clicked        ← salvaged from PLAIN ENGLISH
    6. Type "Hi"                  → ok
    7. Press ENTER                → ok
    ✅ message sent to Fiona Harris
    ```
    Step 5 is worth noting: the stub replied *"I will click the message box
    now (cell F8)"* with no JSON at all, and the prose-salvage path from #82
    turned it into a real click.

    **Bug caught during this work:** the first browser run looped on the same
    click 10 times and hit the step budget. Cause was a stale stub holding
    port 11434, not the agent — confirmed by curl before changing any code.
    The budget doing its job is exactly why that was a contained failure
    rather than a runaway.

86. **`/dev` page — version and release notes, served locally.**
    `http://localhost:8000/dev`, backed by `VERSION.json` and
    `/api/version`. Shows the current version and codename, release date,
    assertion count, platform, whether desktop actions are enabled, and
    whether Ollama is reachable with how many models — all live from the
    running server, not baked into the HTML. Release notes are collapsible,
    newest expanded, each change tagged feature / fix / safety / note.
    Rendered with escaping throughout; only backtick-code spans are
    interpreted.

87. **Runtime-centric architecture — the AI is now a service, not the driver.**
    Four new subsystems in `js/runtime/`, built to make one claim enforceable:
    *the AI never manipulates the OS directly*.

    **`command-registry.js`** — 32 namespaced commands, each with a parameter
    schema, a risk level and the permission it requires. `validate()` is the
    only way in. An invented command (`format_disk`, `shell.exec`) is rejected
    before the Runtime sees it, and a real command with a missing required
    parameter is rejected too, naming the parameter. Aliases live here in ONE
    place instead of the three scattered normalisation layers that existed
    before (`open_app`/`launch`/`open` → `desktop.launch_app`).

    **`runtime-core.js`** — a single `execute()` entry point with five ordered
    gates: **registry → permission → precondition → confirm → execute**. Each
    is a hard return, not a warning. Read-only commands skip confirmation so
    the prompt stays meaningful. `dryRun` validates and checks every gate
    without executing. Throwing executors are contained and counted.
    This sits *in front of* the existing server-side gates in `automation.py`
    and the Action Manager — it does not replace them.

    **`world-model.js`** — persistent desktop state: apps, running processes,
    screen geometry, last observation, action history. Every fact carries a
    timestamp and a TTL, and `describe()` renders them as *"Running (4s
    ago)"* rather than implying now. Launching an app updates the running
    list optimistically; any `input.*` action invalidates the screen, because
    what we saw is no longer what is there. Bounded to 60 actions.

    **`desktop-knowledge.js`** — WhatsApp search is Ctrl+F, Slack is Ctrl+K,
    VS Code's palette is Ctrl+Shift+P, and the macOS close button is at the
    top-**left**. Injected as prompt hints so a 7B model spends its one hard
    judgement on *where is this on screen* rather than rediscovering
    shortcuts. Returns `''` when nothing is known — never filler.

    **Bug caught while wiring:** `this.runtime` already meant `LocalRuntime`
    (the hardware/transport probe). Assigning the kernel there would have
    silently broken the OPS panel and every plugin reading it. Renamed to
    `this.kernel`; there is now a browser assertion that LocalRuntime is
    intact.

    **Architecture violations caught by the existing test and fixed properly,
    not silenced:** `js/ai/task-agent.js` was importing `js/runtime/*`
    (layer 4 reaching into layer 6) — the registry and knowledge base are now
    *injected* by the composition root. And the Dev Console's `_render*`
    methods were dispatched by computed string, making them look orphaned;
    replaced with an explicit switch.

88. **Developer Console** — `DEV` in the dock. Live pipeline diagram that
    pulses as USER → INTENT → PLANNER → VISION → RUNTIME → DESKTOP light up,
    plus five tabs: Overview (runtime stats, AI state, recent dispatches),
    World (the world model with freshness), Commands (all 32 with ready/not
    and the reason why not), Events (every bus event, filterable), Logs
    (filterable, with severity).

    Captures by wrapping `bus.emit` — a console that only sees events someone
    remembered to forward is not a console. Buffers are capped at 300 and the
    DOM is only touched while the panel is visible; this project has already
    fixed two unbounded-DOM leaks and was not going to add a third. Verified:
    600 flooded events leave the buffer at exactly 300.

89. **CORRECTION: "AURA places its own cursor on your screen" was false.**
    The user reported never having seen it. They were right, and the claim was
    mine. `ScreenCursor` drew a reticle onto the **preview canvas inside the
    SCREEN panel** — a picture of the screen with a circle drawn on the
    picture. Nothing was ever drawn on the actual desktop. A web page cannot
    do that; only a native process can. I described a real feature and shipped
    a cosmetic one.

    **`overlay.py`** is the real thing: a borderless, always-on-top,
    **click-through** Tk window that paints a high-visibility reticle at a
    real screen coordinate.
    - Windows: `WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW` via
      ctypes, so clicks pass straight through and it stays out of alt-tab.
      Without that flag the overlay would swallow the very clicks AURA is
      trying to make.
    - Colour-keyed transparency (`-transparentcolor`) so only the marker is
      visible, not a grey box.
    - Runs in its own thread with a command queue — Tk is not thread-safe and
      must never share the HTTP server's threads.
    - macOS/Linux: click-through is not reliable, so the window is kept small
      and the limitation is reported rather than hidden.
    - Styles: reticle / ring / crosshair / dot. Default `#00FF88`.

    **Proven, not asserted.** Run under Xvfb, captured the root window with
    ImageMagick, and counted pixels matching the reticle colour:
    **2392 with the reticle shown, 0 after `hide()`.** Screenshot:
    `screenshots/29-desktop-reticle.png`.

    `/find` now calls `overlay.show()` on success, so the marker appears on the
    desktop. New `/reticle [x y|test|off]` for direct control.

90. **Virtual desktop control — the user's own idea, and the right one.**
    Their blocker: "I can't leave my laptop after giving AURA a task."
    Their solution: give AURA its own Windows 11 desktop.

    **`vdesk.py`** creates, switches and closes virtual desktops.
    `/desktop setup` gives AURA its own workspace and remembers where you
    were; `/desktop aura` and `/desktop home` move between them.

    **Why keyboard shortcuts and not COM:** Windows has never shipped a public
    virtual-desktop API. `IVirtualDesktopManagerInternal` is undocumented and
    its GUID changes between builds, which is why third-party tools break
    after updates. AURA uses the documented shortcuts Microsoft guarantees
    (`Win+Ctrl+D`, `Win+Ctrl+Left/Right`, `Win+Ctrl+F4`).

    **The honest cost of that choice:** there is no stable way to *read* the
    current desktop index, so AURA tracks it by counting its own switches.
    That is a belief, and the API says so — `confidence`, plus `resync()` for
    when you switch by hand. `go_to()` refuses to step more than 8 desktops
    rather than mashing arrow keys on a bad number.

    **Stated plainly in the API and the UI:** Windows has ONE pointer, shared
    across all desktops. Separate desktops keep AURA's *windows* off your
    workspace; they do not give it a second mouse. It is a real improvement,
    not the full isolation a VM would give.

    Verified: 34 assertions in `tests/test-overlay-vdesk.py`, run on Linux
    where both are unavailable — the point being that every entry point
    refuses with a specific reason instead of pretending.

91. **AURA Live — screen control promoted from sidebar panel to its own page.**
    Everything screen-related was spread across a narrow sidebar panel and
    nine slash commands. It is now one full page at **`/screen`** (also
    `/live`), and the dock button is a real link, not a panel toggle.

    **Every command has a control.** Nothing was removed — the slash commands
    still work in the main app, because the page imports the *same* modules
    (`screenShare`, `ScreenAgent`, `TaskAgent`, `localActions`, `Trace`)
    rather than reimplementing them. One source of truth, two front-ends.

    | Command | Control |
    |---|---|
    | `/watch` | SHARE SCREEN / STOP + live preview |
    | `/watch ask` | ASK view with presets and streaming answer |
    | `/screenmode` | three-way reading-mode picker |
    | `/find` | FIND view + **live 12×8 grid map** showing the hit cell |
    | `/here` | CLICK THE MARKER |
    | `/do` · `/task` | ACT view, segmented single-step / agent-loop |
    | `/reticle` | marker card: 6 colours, 4 styles, show/hide |
    | `/desktop` | DESKTOPS view with a visual workspace strip |
    | `/automation` | arm/disarm card with live expiry countdown |

    **Glassmorphism UI** in `css/live.css`: layered translucent panels with
    `backdrop-filter`, ambient gradient orbs (cyan/purple/pink/green), SVG
    noise to kill gradient banding, cursor-tracked specular highlights,
    spring easing (`cubic-bezier(.22,1.4,.36,1)`), ripple clicks, blur-morph
    view transitions, shimmer skeletons, magnetic buttons, morphing modal.

    **Performance was a design constraint, not an afterthought.** Every
    animation is transform/opacity/filter only — nothing triggers layout.
    Blur is bounded to a fixed set of surfaces. Preview redraws at 4 fps
    (the capture is 1 fps; faster is wasted work). Ambient and motion each
    have an off switch in Settings, and `prefers-reduced-motion` is honoured.
    This project runs on a modest machine; a UI that drops frames is not
    premium.

    **Android button is honest.** It opens a modal that says under
    development, explains the intended approach (ADB/scrcpy mirroring through
    the same grid pipeline), and states plainly *"nothing about it works
    yet"*. Asserted in the test suite, so it can never quietly imply a hidden
    feature.

    **Two things the tests caught, fixed rather than silenced:**
    - `test-architecture` found 10 **dangling DOM references** — `main.js`
      still wired `#scr-preview`, `#scr-badge` and friends after the panel was
      deleted. The dead handlers and the whole preview loop were removed; only
      the trace log stays mounted so main-app commands still stream.
    - It also caught `Trace` being imported from `ui/trace-view.js`, where it
      no longer lives (it moved to `core/trace.js` in v0.15).

    Verified: 49 assertions in `tests/test-live-page.py` — the page renders,
    all 7 views navigate, sharing starts and the preview draws **922 sampled
    bright pixels**, `/find` highlights exactly 1 grid cell, the mode picker
    persists to config, and the main app still registers all 71 commands with
    zero console errors.

    **Test-harness bug found and fixed:** `fake-screen-ollama.py` matched its
    `STRICT JSON` branch before its `Find:` branch, so `locate()` received a
    plan instead of a cell. Verified with `curl` before touching product code.

92. **Privacy Guard — minimise the active window when someone appears behind you.**
    `js/vision/privacy-guard.js` + `windows_mgr.py`. Off by default,
    conservative by default, permission-gated.

    **It reuses the existing pipeline and adds no cost.** `vision.js` now
    emits `EV.PRESENCE` from detections that ALREADY ran on the current
    frame — no second camera, no second MediaPipe graph, no LLM, no
    screenshot, nothing leaves the machine. The event is rate-limited to
    change-or-400ms so it does not flood the bus. Faces are preferred over
    COCO `person` boxes: the face landmarker is always on, far cheaper, and a
    much stronger "someone is behind me" signal.

    **Six states** — DISABLED · ARMED · MONITORING · THREAT_DETECTED ·
    ACTION_EXECUTED · COOLDOWN — with confidence, persistence and proximity
    gates. `area` (fraction of frame) is the only honest proximity proxy a
    single camera has, and it is documented as such, not sold as distance.
    Three presets: Sensitive / Balanced / Conservative (default).

    **No coordinates, ever.** `windows_mgr.py` calls
    `user32.ShowWindow(hwnd, SW_MINIMIZE)` through ctypes — the same call
    Windows makes. Clicking a minimise button would break on theme, DPI,
    maximised state and custom title bars. macOS uses AppleScript
    `AXMinimized`; Linux uses wmctrl/xdotool and says so plainly when absent.

    **Vision can never act on its own.** The guard PROPOSES one registry
    command and the Runtime decides:
    `Vision ▸ PrivacyGuard ▸ registry ▸ permission ▸ execute ▸ ShowWindow`.
    Asserted: with the permission denied, the command is proposed, refused at
    the permission stage, and the guard enters cooldown instead of retrying.

    **It never auto-restores.** There is no restore command in the registry
    at all, and that is asserted. If detection blinks, re-showing the window
    would re-expose the screen while the person is still there.

    **Two real bugs found by the tests, both fixed:**
    - **Cooldown could be bypassed.** It compared against the *event*
      timestamp, which is a monotonic clock that can lag or arrive out of
      order — a stale burst re-fired the action **3 times**. Cooldown now uses
      wall clock; persistence still uses the event clock, because that
      describes the detection rather than the reaction. Verified: 1 trigger,
      20 suppressed.
    - `persistingMs` read 0 whenever frames arrived faster than the wall
      clock ticked, so the UI progress bar never moved.

    Verified: 65 assertions in `tests/test-privacy-guard.mjs` (all eight
    specified scenarios plus threshold, safety and bus-isolation cases) and
    37 in `tests/test-privacy-ui.py` in a real browser.

93. **Object detection diagnosed and fixed — it was a threshold, not a bug.**
    The user reported object detection as unreliable. It was, but the model,
    the `.tflite` file, the delegate and the plumbing were all fine.

    Method: instrumented the silent `catch {}`, confirmed no error; called the
    detector directly (worked); ruled out timestamp strategies; then re-ran
    the same model with `scoreThreshold: 0.01`. The **best** detection scored
    **0.453** and everything else sat between 0.019 and 0.043.

    EfficientDet-Lite0 on a 640px webcam frame genuinely produces low
    confidences. At the old `0.42`, a correct detection sat a hair above the
    cut-off and flickered in and out — which reads as "broken" rather than
    "threshold too high". Now `0.28` (configurable via
    `config.objectScoreThreshold`), `maxResults` 8 → 12, and the empty catch
    now records `_objectError` so a real failure can never look like an empty
    room again.

    Verified in-browser after the change: detections at **0.32–0.675** now
    reach `_lastObjects`, on 3 of 12 sampled frames. Hand tracking, face
    tracking, gestures and the camera are unchanged — asserted.

94. **Privacy Guard fired on the owner — reported failure, fixed.**
    *"even when no one was behind me, when I showed it my own face it
    minimized."* Correct, and the design was wrong, not the tuning.

    v1 gated on **face size only**. The largest face at a laptop is always the
    person using it, so the owner always qualified. No threshold could fix
    that — a bigger `minArea` just means leaning forward triggers it.

    Two rules now run **before** the confidence and proximity checks, using
    facts the pipeline already had:

    - **`minFaces: 2`** — one face is you working; two is someone with you.
    - **`neverIfOwnerAlone: true`** — if every face in frame is enrolled and
      none is unknown, stand down and say who was recognised.

    An **unknown** face still counts toward `minFaces`, so a stranger leaning
    in beside you triggers exactly as intended.

    **Supporting change in `vision.js`:** `_identifyFace()` only ever looked at
    `faces[0]`, because it exists to greet one arriving person. Privacy Guard
    needs the opposite question — *is anyone here NOT enrolled?* — so
    `_identifyAll()` now recognises every face (max 4, throttled to ~3 Hz) and
    caches names plus an unknown count. `EV.PRESENCE` carries `faceCount`,
    `knownNames` and `ownerPresent`.

    The UI shows faces in frame, who was recognised, and the live stand-down
    reason (*"🛡 Standing down — all 2 face(s) recognised (Aryan, Mum)"*), plus
    a link to the existing face-enrolment UI rather than a second one.

    Verified — 81 assertions in `tests/test-privacy-guard.mjs`, 22 in
    `tests/test-owner-live.py` in a real browser:

    | Scene | Result |
    |---|---|
    | Owner alone | **no trigger** ✓ (the reported bug) |
    | One unrecognised face alone | no trigger |
    | Owner + stranger | **triggers** ✓ |
    | Two enrolled people | no trigger, names given |
    | Two unknown faces | triggers |
    | `neverIfOwnerAlone` off | 2 enrolled faces trigger |
    | `minFaces: 1` | old behaviour, opt-in |

95. **AURA Live visibility toggle.** Settings → Vision → *Show AURA Live*.
    Hides the dock entry and skips its wiring; stored as
    `config.auraLiveEnabled`. **Nothing is deleted** — `/screen`, `live.html`,
    `live.css` and `js/live.js` are untouched, the route still returns the full
    12,776-byte page while hidden, and re-enabling restores it unchanged.
    Asserted both ways.

96. **AURA Live was broken by a one-word typo, and it was mine.**
    `js/live.js` called `app.ai.resolveProvider?.()`. The method is
    `resolve()` — there is no `resolveProvider`. **Optional chaining made it a
    silent no-op**, so the engine never picked a provider and every
    model-backed feature on the page (ASK, FIND, ACT) reported *"No
    image-capable model installed"* even with Ollama running perfectly in the
    main app. That is exactly the "it doesn't work" the user reported.

    Fixed, and the `?.` removed so a future failure is loud rather than
    silent. Verified against a live model: reader resolves to `qwen2.5vl:7b`,
    ASK answers, FIND returns cell C4.

97. **Face enrolment now shows what it is doing.**
    It was text-only (*"Captured 1/3"*), which reads as nothing happening.
    While enrolling, the face gets a **sweeping scan bar**, a **dense mesh**,
    and a **live percentage ring** above the head — all drawn from landmarks
    the pipeline already produced, so no extra detection cost.

    **Bug found while building it:** the identify path was gated on
    `config.faceRecognition`, which is **off by default**. Starting an
    enrolment while it was off meant `addSample()` was never called — the
    counter genuinely sat at 0 and nothing was happening. Enrolment now always
    runs the identify path (enrolling *is* the opt-in), and
    `vision.startEnrollment()` arms the overlay on the first frame instead of
    waiting for an identify that would never come.

    Measured: 188 painted samples, 155 of them in the scan colour.

98. **Device Gateway — pair a phone over the LAN.**
    `devices.py` + `/phone` + `js/phone.js`.

    **Transport is long-polling, not WebSocket, and the reason is stated in
    the module.** `serve.py` is stdlib-only; a WebSocket means adding a
    dependency or hand-rolling RFC 6455 framing. Long-polling gives the same
    LAN-latency behaviour (**measured 7–17 ms**), and reconnect after a Wi-Fi
    drop is free because every poll is just another HTTP request. The
    transport is isolated behind `poll()`/`enqueue()`.

    **Security, which is the part that matters:**
    - Pairing needs a 6-digit code shown on the laptop; single-use, 3-minute
      expiry. Redeeming it returns a 32-byte device token.
    - Two route classes: `/api/device/*` takes the DEVICE token and offers
      only pair/heartbeat/poll/ack. `/api/devices/*` takes the HOST token.
      **There is no route by which a phone can run anything on Windows** —
      asserted by scanning the module for shell/exec entry points.
    - Declared capabilities are filtered against an allowlist at pairing, so a
      device cannot invent `shell_exec` to unlock a route.
    - Verified over real HTTP: `/api/devices` → 401, `/api/devices/send` →
      401, forged device token → 401.

    **Device-aware routing.** `device.open_url` resolves "phone", "my phone",
    a device name, or an id; "laptop"/"windows"/"this computer" resolve to the
    host and are executed locally rather than sent to the gateway. An offline
    phone returns `offline: true` with *"last seen 46s ago"* — it never
    reports success.

    Verified: 61 assertions in `tests/test-devices.py` (spec tests D, E, F, G,
    L, M, N) and 29 in `tests/test-phone-page.py` in a real browser — pairing
    through the UI, heartbeat at 7 ms, `open_url` delivered and executed.

99. **Phone camera reported honestly — four distinct causes.**
    The old *"this browser exposes no camera API"* conflated everything. The
    companion page now reports **secure context** and **getUserMedia
    availability** separately, and on failure distinguishes permission denied
    / no camera found / camera in use / unsupported.

    On plain LAN HTTP it says the insecure context is the cause, lists the
    three real remedies (self-signed HTTPS, a TLS tunnel, or Chrome's
    `unsafely-treat-insecure-origin-as-secure` flag), and states plainly that
    **AURA cannot work around this from JavaScript and will not pretend to**.

100. **The Privacy Guard text really was overlapping the camera logs.**
     User-reported, and exactly right. `#trace-log` was an in-flow child of
     `<aside class="panels">`, while every `.panel` is `position:absolute;
     inset:0` with a **transparent** background. A running trace therefore
     painted in normal flow and the panel was drawn straight over the top of
     it. `elementsFromPoint()` at one pixel returned
     `['h2', 'header.panel-h', 'section.panel', 'div.trace-head', 'div.trace']`
     — two independent text layers fighting for the same pixels.

     Fixed structurally, not with a z-index patch: `.panels` is now a flex
     column holding `.panel-stack` (which owns the absolute panels) and a new
     opaque `.trace-dock` **sibling**, capped at 42% height. The trace takes
     real space and the panel shrinks to fit.

     Two follow-ons from the same change: `.panel-stack` needed
     `overflow:hidden` to keep clipping the 14px `translateX` of the `panelIn`
     animation (`.panels` used to do that job), and the dock is capped at 34%
     under 900px where the sidebar is only 52dvh.

     Found and measured by a new detector, `tests/find-overlaps.py`, which
     walks the real DOM across 3 viewports × 6 panels × trace-on/off plus all
     three standalone pages. It reported **240** collisions before, **0** after.
     Note the detector itself needed two fixes to be trustworthy: it must
     intersect each box with its scrolling ancestors (`getBoundingClientRect`
     reports geometry for content scrolled far out of view, which made
     scrolled-away wardrobe swatches look like overlaps), and a clipped box
     only counts when it actually hides **text**, not a decorative scan bar.

101. **ENABLE CAMERA was cut off at 1280x800.** `.cam-placeholder` is taller
     than the 4:3 `.cam-wrap` on short viewports, and the wrapper clips —
     so the button you need in order to fix "Vision offline" was itself
     hidden. Measured overflow: 33px at 1440x900, **43px** at 1280x800.
     Same bug on `/screen`, where `.screenbox` clipped CHOOSE A SURFACE.
     Both now scroll instead of clipping.

102. **Dwell fired three times from one intent.** A hand resting perfectly
     still on one button clicked at 1023ms, 2970ms and 4917ms. The cooldown
     was `elapsed >= cooldownMs || moved > reFireRadius` — with OR, time alone
     released the latch under a motionless finger. It has to be time **AND**
     distance: the fingertip must actually leave the target before that target
     re-arms. Caught by `tests/test-dwell.mjs` before it ever ran in a browser.

     Consequence worth noting: once distance does the real work, the time
     floor should be *short*. It was lowered 900ms → 250ms, because a long
     cooldown only punishes someone who correctly moved on to another button.

103. **The progress ring flashed 0% at the moment of the click.** On the
     firing tick `update()` has already zeroed `progress` and moved to
     COOLDOWN, so `ringPercent()` read 0 exactly when the ring should show a
     satisfying 100%. Anything rendering that tick must quantise the returned
     **result**, not live controller state. Split into
     `DwellController.ringOf(p)` (pure) with the trap documented on the
     instance method, and guarded by a regression test that asserts the
     divergence explicitly.

104. **`InteractionManager` called a method that does not exist.**
     The desktop-click path called `this.actions.execute('automation_run', …)`,
     but `LocalActions` has no `execute` — the method is
     `automationRun(plan, confirmed)`. `tsc --noEmit` caught it before it ever
     ran; without the type check it would have been a silent runtime failure
     on the one path this sandbox cannot exercise.

105. **The settings tab strip was crushed, not hidden.** User-reported: *"when
     in settings, i click on desktop or any tab with large settings option, the
     ui hides the above bar"*. `.tabs` is a flex child of `.modal-box` with the
     default `flex-shrink: 1`, so a tall tab-pane squeezed the strip out of its
     own content height. Measured: **26px → 16.7px at 1440x900, 12.4px at
     800x460** — the labels became an unreadable sliver, which is the thin line
     visible in the user's screenshot. `.tabs` and `.modal-h` are now
     `flex: none`, `.modal-body` owns the shrinking, and switching tabs resets
     `scrollTop` so a short pane never opens mid-scroll.

106. **The microphone turned on and off forever on first login.**
     User-reported. The restart-storm guard added in an earlier round
     **defeated itself**, and the arithmetic proves it: it counted a "rapid"
     end as a gap under `900ms` between ends, but its own backoff was
     `260 + rapidEnds * 400` — so the third retry waited **1060ms**, which is
     more than 900, so `_rapidEnds` **reset to 0**. The counter oscillated
     0→1→2→0→1→2 and never reached its limit of 6. Simulated over 14 restarts:
     the guard never fires.

     Fixed with two independent rules, because either alone still has a hole:
     judge an attempt by how long recognition actually **ran** (`onstart` →
     `onend`), not by the gap between ends; and count **consecutive** failures,
     where only a session that produced a result or survived 700ms resets the
     streak. The backoff is also capped at 2s, since the counter — not the
     delay — is what ends the loop now.

     Measured after the fix: a mic that dies instantly gives up after 5 retries
     (~7s) with an actionable message; a healthy mic running 2s sessions is
     never shut off across 500 iterations. The guard was extracted from the
     `onend` closure into a pure `decideRestart()` so it is unit-testable in
     Node without a browser recogniser.

107. **The companion page assumed every device was a phone.**
     User-reported: they opened `/phone` in a second window on the same Windows
     laptop and it paired as `android-001`, "Phone", credited with a vibration
     motor it does not have. The page now offers Android / iPhone / Windows /
     macOS / Linux with an **AUTO-DETECT** button, and the selection drives the
     capability set, the default name and the page copy.

     Two safeguards worth noting. The platform profile is intersected with the
     live feature test, so choosing "Android" on a desktop cannot conjure
     `vibrate` — the feature test always wins. And `devices.py` validates the
     platform server-side against `KNOWN_PLATFORMS` and re-filters capabilities
     against that platform's ceiling, so a hand-crafted pair request cannot
     claim a capability its class does not have. Verified: a bogus
     `root_shell` capability and an unknown platform are both dropped.

     Also fixed while here: `resolve("phone")` matched `platform == "android"`
     only, so an **iPhone would never resolve** to "my phone". It now matches
     on device `kind`.

108. **Settings → Devices did not exist.** The companion page instructed users
     to "open Settings → Devices and press PAIR A DEVICE" — a section that was
     never built. Pairing was reachable only through the `/devices` chat
     command, which is not discoverable. Built for real: pairing code with a
     live countdown, the companion URL, a LAN reminder, and the paired-device
     list with per-device status, latency, battery, capabilities and unpair.
