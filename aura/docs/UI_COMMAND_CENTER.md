# AURA — Command Center UI

Presentation-layer upgrade. **No AI logic, runtime, plugin or backend code was
changed** — the new UI only subscribes to the existing event bus and reactive
store.

## The rule I held to

Every element on screen traces to a real source. Where a value genuinely
cannot be read, the panel prints **why** instead of a number.

Concretely: browsers cannot read system CPU or RAM. `performance.memory` is
the JS heap, not the machine. Rather than invent a plausible-looking gauge, I
added a real `/api/metrics` endpoint to `server/serve.py` backed by **psutil**, and a
provider that degrades honestly:

```
CPU     93%     2 cores · 2.6 GHz          ← real, from psutil
MEMORY  47%     1.0 GB / 2.1 GB            ← real
DISK    21%     20.2 GB free of 25.9 GB    ← real
GPU     N/A     No GPU telemetry (needs nvidia-smi or vendor tooling)
```

Without the local server, the same panel reads:
`Browsers cannot read CPU load (8 cores detected) — awaiting local runtime provider`.

## Panels and their data sources

| Panel | Source | Live proof |
|---|---|---|
| **AI Core** | `state` + `ai:*` events | Provider, model, Ollama, route, `178 ms · 3 chunks` |
| **System Monitor** | `MetricsManager` → psutil | CPU/RAM/disk/GPU + sparklines from recorded samples |
| **Agents** | `state` + runtime + registries | 5 agents; Desktop shows real `1/13 permissions` |
| **Memory Center** | `MemoryManager` (4 categories) | Counts match the engine exactly |
| **Voice Interface** | `voice:*` events | STANDBY → LISTENING → PROCESSING → SPEAKING |
| **Plugins & Tools** | `PluginRegistry` + `ActionManager` | 17 plugins · 52 commands · 22 actions |
| **Activity Feed** | `bus.on('*')` wildcard | Every event, timestamped, noisy ones muted |

## Layout

```
┌──────────────────── top bar ────────────────────┐
│ dock │        AVATAR / STAGE          │ COMMAND │
│ CHAT │   ┌───────────────┐            │ CENTER  │
│ VISION│  │ LIVE ACTIVITY │  ← feed    │ ─────── │
│GESTURE│  └───────────────┘            │ AI CORE │
│ OPS  │                                │ AGENTS  │
│ STYLE│                                │ SYSTEM  │
│SYSTEM│                                │ MEMORY  │
│ MIC  │   ┌── voice HUD ──┐            │ PLUGINS │
│ VOICE│   │ ▁▃▅▇▅▃▁ STANDBY│           │         │
└──────┴──────────────────────────────────────────┘
```

- **Left** — existing dock, plus a new **OPS** entry
- **Centre** — avatar, with the activity feed and voice HUD as glass overlays
- **Right** — the command center stack
- **Bottom** — voice waveform, always visible

## Event-driven, no refresh buttons

Panels update from 54 bus events. Renders are coalesced into one paint per
frame via `requestAnimationFrame`; state transitions render synchronously so
they are correct even while a panel is hidden.

## Honesty notes

- **Mic waveform amplitude while listening is animated, not measured.** The
  browser does not expose mic amplitude without an `AnalyserNode` on the
  stream. It is a liveness indicator only. Speaking amplitude *is* real —
  driven by TTS viseme openness.
- **GPU load** is unavailable on most systems; the panel says so.
- Sparklines plot only genuinely recorded samples — no synthetic history.

## Tests

`python3 ../tests/test-command-center.py` — **54 assertions**, including a
fake-data audit that greps the rendered DOM for lorem ipsum, placeholders,
TODO markers and stub names.
