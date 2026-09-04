# v0.22.0 — Command Gold

You sent a very detailed spec for a Brahma-Echo-style command center. I compared
it against AURA before writing anything, because most of it already existed.

---

## First: what the spec asked for that AURA already had

| Spec section | Already in AURA |
|---|---|
| §3 Provider abstraction | Gemini / OpenRouter / Ollama / local core |
| §4 Tool registry + schemas | 43 registry commands |
| §5 Permission tiers | RISK tiers, 15 permissions, 5 kernel gates |
| §18 Plan → execute → verify | `/task`, a 14-step agent loop |
| §20 Activity event stream | Trace, streaming live |
| §25 Computer control | `automation.py` |
| §26 Screen analysis | `/watch`, `/look`, 12×8 grid grounding |
| §29–31 PPTX / XLSX / DOCX | `services/docgen/builder.py` |
| §41–45 QR pairing, gateway | `devices.py` |
| §68 Demo mode | `[SIMULATED]` labelling |
| §71 File management | `organizer.py` |

You chose to **keep AURA's stack** rather than rewrite in React + Tauri. I agree:
the stack is a means, the experience is the goal, and rewriting would have cost
every one of the 2,533 passing assertions before delivering anything new.

---

## The AI Sphere

AURA's avatar is now a **golden energy sphere** — orbital rings, a particle
shell, horizontal energy bands and a glowing core, rendered on canvas.

It is **not decoration**. Nine states, each wired to a real subsystem event:

| State | What actually triggers it |
|---|---|
| listening | `voice:stt-start` — the microphone is genuinely open |
| thinking | `ai:stream-start` — a model call is in flight |
| planning | a trace whose title mentions plan/understand/outline |
| executing | any other trace — a tool is running |
| success | `trace:end` with state `ok` |
| error | `trace:end` with state `fail`, or a failed action |
| connecting | a pairing window really opened |
| connected | a new device really appeared in the list |

No timer, no random walk. If the sphere says executing, a tool is executing.

I measured that the states are genuinely distinguishable rather than trusting my
eyes — lit-pixel count and mean brightness per state:

```
idle        1191   listening   1816   thinking    1409
planning    1575   executing   2062   success     3258
error       1816   connecting  1868   connected   2970
```

`success` nearly triples the ink; `error` measurably shifts hot and red.

**Performance:** the particle budget auto-tunes from real frame time. On this
software renderer it settled from 1100 down to 260 particles by itself. Reduce
Motion freezes the rotation but keeps it rendering, so nothing goes blank.

### A bug worth naming

The sphere first drew into a **1×1 canvas** stretched across the whole stage —
visible as a faint arc. `init()` measured the container before layout, got 0×0,
and clamped to 1px; nothing re-measured afterwards. A `ResizeObserver` fixes it
at the source, and `resize()` now ignores a zero measurement instead of
clamping. Ink went from **1 → 12,926**.

---

## Command Gold

Near-black `#050505` with a warm gold `#f5b23c` accent, now the default theme.

The backgrounds stay **neutral black** deliberately. A warm background plus a
warm accent muddies both — the gold only appears in the accent, borders and
glow, where it carries meaning. Every other theme is still there.

---

## Task cards

A complex command now produces a real card:

```
Presentation                                  22ms
make me a ppt on brahma ai
  1. Understand the topic      ✓ struck through
  2. Build a slide structure   ✓
  3. Generate the deck         ← active
  4. Open the presentation
  ▓▓▓▓▓▓▓▓░░░░░░░  progress from REAL steps
  [CANCEL]
  📊 Presentation  /home/user/AURA/deck.pptx  [OPEN]
```

Two things I refused to fake:

- **Progress can never reach 100% while the task is running.** It is the count
  of real completed trace steps against the declared plan, capped at 97% until
  the task genuinely ends. `Trace.progress` cannot express a lie.
- **A cancelled task can never report success.** `Trace.end()` downgrades `ok`
  to `warn` if it was cancelled, whatever the caller passes.

Cancellation is honest about being cooperative: the button reads **STOPPING…**,
because a native OS call already in flight cannot be killed mid-syscall.

---

## Numbers

| | |
|---|---|
| Version | 0.22.0 "Command Gold" |
| Assertions | **2685** (was 2533) |
| New suites | `test-sphere.mjs` 87 · `test-sphere-ui.py` 65 |
| TypeScript errors | 0 |
| Console errors | 0 |
| Layout collisions | 0 |

Two existing tests failed after this change and **were themselves right to** —
they asserted "three providers" and "built-in is the default". Both were updated
to the new reality while still proving the humanoid works and stays selectable.

---

## Still not built — being straight

The spec is large and I did not finish it. Remaining, roughly by size:

1. **Website generation + developer mode** (§32/§33) — the biggest one. Needs a
   sandboxed project workspace and a dependency-install policy.
2. **Prompt-injection defense** (§85) — web and file content is already passed
   as data rather than instructions, but there is no dedicated test proving a
   malicious page cannot escalate to a tool call. I think this should be next:
   it is a security property, and right now it is an assumption rather than a
   guarantee.
3. **Discord bot** (§52) — needs a persistent gateway connection.
4. **Auth / web portal** (§57) — AURA is single-user and local today.
5. **Update system** (§55) — no distribution channel.
6. **Startup particle animation** (§50) — the boot sequence still uses the log.
7. **Smart home** (§34–39) — still dropped, as you decided.

## To try

```
python server/serve.py --allow-actions
```

Watch the sphere while you talk to it: press the mic and it brightens, ask a
question and it accelerates, run `/doc ppt on anything` and it goes gold-hot
while the task card fills in beneath.

Prefer the humanoid? **Settings → Avatar → Built-in**. Nothing was removed.
