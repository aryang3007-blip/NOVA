# AURA — Model Routing & Built-in Guide

## 1. The built-in guide (no model required)

Asking *"how do I use this app?"* is documentation about AURA itself. That
should never need an LLM, so it doesn't. The guide sits at **priority 5** in
the intent router — above web lookup, below maths.

**11 topics**, all answered instantly and offline:

`overview` · `ollama` · `models` · `gestures` · `voice` · `desktop` ·
`vision` · `privacy` · `commands` · `troubleshooting` · `shortcuts`

Answers read **live state**, so they reflect reality:

| Situation | What it says |
|---|---|
| Camera off | "⚪ Camera is off. Open VISION → ENABLE CAMERA" |
| Camera on | "✅ Camera is live. Detecting 2 hand(s), 1 face(s)" |
| Ollama missing | Full install walkthrough |
| Ollama connected | "✅ Already connected, using `gemma2:2b`" |

Commands: `/guide`, `/guide gestures`

## 2. Task-based model routing

AURA reads your installed models from Ollama and routes per task. **No model
names are hardcoded** — capability is inferred from name and size, so a model
you pull tomorrow is picked up automatically.

| Task | Looks for |
|---|---|
| chat | smallest / fastest |
| code | `coder`, `codestral`, `starcoder`… |
| reasoning | `r1`, `qwq`, `thinking`… |
| tools | qwen2.5 / llama3.x / mistral families |
| vision | **whatever Ollama reports** — see below |

### Capabilities come from Ollama, not from the model name

Everything above is a *hint* from the model name. Capabilities are not.

Ollama's `/api/show` returns a `capabilities` array for every model —
`["completion", "vision", "tools", "thinking"]` — computed from the model's
own GGUF metadata. AURA reads it on every discovery and **trusts it over any
name pattern**.

This matters. AURA used to decide "can it see?" with a regex on the name.
The pattern knew `gemma3` but not `gemma4`, so someone holding `gemma4:12b`
— a fully multimodal model — was told none of their models could read images
and pulled another one they did not need. A name pattern can never know
about a model family released after it was written; `/api/show` always does.

`/models` shows which answer you got:

```
**Image understanding (/look):**
👁 gemma4:12b   — confirmed by Ollama
👁 qwen2.5vl:7b — confirmed by Ollama
  ↳ /look will use qwen2.5vl:7b (sees images · vision-capable · 7.6B · fast)
```

If your Ollama predates v0.6.0 it does not report capabilities. AURA then
falls back to a **generic** name guess (`-vl`, `vision`, `multimodal`,
`-mm`, `gemma`≥3, `llama4`) and labels those entries
*guessed from the name — unverified*. Override any wrong guess with
`/pin vision <model>`.

### Which model `/look` uses

Not simply "the first vision model" — that used to be the first name
*alphabetically*, which picked `gemma3:12b` over an available 7B. Order is:

1. `/pin vision <model>` if you set one.
2. The registry's VISION selection, honouring speed-first and measured
   throughput.
3. The smallest vision-capable model.

The 9B ceiling is **not** applied to vision: if the only model that can see
is a 12B, using it slowly beats refusing to answer.

### The size ceiling — the important part

**Auto-routing never selects a model above `maxAutoParams` (default 9B).**

You raised exactly the right concern: a 20B or 30B model can take minutes per
reply on a modest machine. So with a library like yours:

```
⚡ gemma2:2b          2.6B  instant   → chat
🟢 qwen2.5-coder:7b   7.6B  fast      → code, tools
🟢 deepseek-r1:8b     8.0B  fast      → reasoning
🟢 qwen2.5vl:7b       7.6B  fast      → vision
🔴 gemma4:12b        12.0B  excluded from auto-routing — but still available
                                       for /look, and pinnable
🔴 qwen2.5-coder:14b 14.8B  excluded — above the 9B ceiling
🔴 gpt-oss:20b       20.9B  excluded — above the 9B ceiling
🔴 qwen3:30b-a3b     30.5B  excluded — above the 9B ceiling
```

Note `gemma4:12b`: excluded from *auto-routing* for speed, yet still listed
as vision-capable. Exclusion is about latency, not ability — the two are
tracked separately.

Excluded models stay fully usable — you just have to **pin** them:

```
/pin code qwen2.5-coder:14b     → warns it's above the ceiling, then obeys
/pin code none                  → back to automatic
```

### Measured latency beats guesses

AURA records real throughput per model as you use it. If something performs
badly on *your* hardware, it is demoted from auto-routing even when it's under
the ceiling — measurements are trusted over parameter counts.

### Configuration

| Setting | Default | Effect |
|---|---|---|
| `maxAutoParams` | `9` | Auto-routing ceiling in billions |
| `modelStrategy` | `speed` | `speed` \| `balanced` \| `quality` |

`speed` strongly prefers smaller models for chat — matching how you described
using Gemma2:2B day to day.

Command: `/models`

## 3. Bug this work surfaced

Testing caught something significant: **questions were triggering actions.**

> "how do I enable the camera" → *turned the camera on*
> "how do I open WhatsApp" → *launched WhatsApp*

The SYSTEM and TOOL router stages matched the verb without checking whether
the sentence was a question. Both stages now bail on interrogative phrasing,
so questions get explained and only imperatives act. Locked in with 15
regression assertions.

## Tests

`node ../tests/test-models.mjs` — **106 assertions**, run against your real model
list, including a check that *every* task avoids the 20B/30B models.
