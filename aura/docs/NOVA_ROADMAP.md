# NOVA — Agent-Managed Upgrade Roadmap

Owner: Arena agent (acting as NOVA's engineering manager). This file is the
living plan. Each wave lists what shipped, what proved it (tests), and what I
have queued next without waiting to be asked.

Operating directive (from Aryan):
working features over UI polish · never fake tool results · UI selection is
authoritative · no new hardcoded voice phrases · catastrophic commands never
run · preserve every existing feature.

---

## ✅ WAVE 1 — DB integration, vision truth, desktop safety (shipped)

- Vault **key profiles** (`{profiles:{name:{provider:key}}}`, legacy
  auto-migration) + `GET /api/db/vault/profiles` + `GET /api/db/vault/reveal`
  → a fresh browser session imports keys instead of re-pasting them.
  `config.keyProfile` selects the profile; `config.importKeysFromProfile(name)`
  forces a switch. *API-key persistence across sessions: FIXED.*
- **Cloud vision routing**: `screen-agent.pickVisionBackend()` — a keyed API
  provider (Gemini/OpenAI/Groq/OpenRouter/Anthropic, or pinned
  `visionProvider`) now receives LIVE/Desktop screenshots for ASK / FIND /
  ACT; local Ollama vision is the offline fallback. *"screenshots never reach
  the API model": FIXED.*
- **Catastrophic command hard-blocks** (`bridge.CATASTROPHIC_PATTERNS`): disk
  erase, power, registry/boot, account/AV tampering, fork bomb are refused
  under `ask` AND `strict`; `confirmed=True` cannot override.
- Pre-existing bug fixed: millisecond message-ID collision silently merging
  conversation turns (nanosecond+counter ids).
- Architecture hygiene: removed L4→L6 import violation + dead settings
  bindings + stray console.log.
- Proven by: test-database 55, test-bridge-security 48, test-persistence 18,
  test-architecture 23, test-core 112, test-actions 27, test-desktop-tools 37,
  test-desktop 145, test-devices 61, test-capabilities 21.

## ✅ WAVE 2 — Orchestration core (shipped)

- **../js/ai/router.js`** — one authoritative provider+model resolution for
  chat/vision/tools/docgen (`resolveChat`, `complete`, `completeJSON` with
  lenient repair + honest via-reporting). Kills the "fake selector" class of
  bug (doc-agent read `.id` off a string and always fell back offline).
- **../js/ai/semantic-tools.js`** — unified capability registry (OS tools +
  NOVA services: documents, research, screen, devices, tasks) with
  structured parameter descriptors; model-driven selection as the
  conversation-adjacent fallback; hallucinated tool names rejected; device
  argument kept separate from app names; `verifyAndNarrate` (no fake success).
  Weak-English/Hinglish verbs recognized (kholo, chalao, banao, dikhao…).
- **../js/ai/context-packet.js`** — bounded per-request context: selected
  backend, paired devices, usable tools, preference/memory rows RELEVANT to
  the request, screen/task/runtime state. Injected into the system prompt.
- **../js/ai/engine.js`** — context packet per turn; semantic action fallback
  stage; NOVA service executors (docgen / research+summary / screen inspect /
  device dispatch with honest "not paired" / task log); every agent action
  recorded as an episode (global task log).
- **System prompt rebuilt** (IDENTITY / PRIMARY OBJECTIVE / OPERATING
  PRINCIPLES) with automatic upgrade for installs carrying the old default.
- **../js/ai/device-router.js`** — named devices ("on Aryan's tablet"),
  "your/another desktop", tablet/fone variants, "phone pe/par" forms.
- **PPT pipeline (Gamma-goal)**: doc-agent generates a structured deck spec
  (10 slide kinds, purpose per slide, speaker notes, narrative arc, audience,
  slide-count honoring, research digest for current topics) via the SELECTED
  API provider; `validateDeck` + `repairDeck` auto-fix weak slides;
  `services/docgen/builder.py` renders professional layouts (hero/section/two-column/
  process/timeline/stats/table/quote/conclusion/references, 4 themes) and
  re-opens the file to validate it (`validate_pptx`) before reporting success.
- Proven by: test-router 47 (new), test-doc-agent 80, test-docgen 82, plus
  full regression — 28 suites, 0 failures (playwright browser tests skip in
  the sandbox, run them on Windows).

## 🔨 WAVE 3 — Queued (self-assigned, in priority order)

1. **Wake-word action loop on Desktop page**: wake phrase → semantic stage
   works today; add "commander follow-up mode" (after wake, one command
   without re-waking) and spoken verification of results. Needs a Windows box
   to validate mic loop end-to-end.
2. **Global tasks surface**: episodes already record every agent action —
   expose them as a task timeline on the EXISTING /dev page (no new UI page,
   per directive), with status (done/failed) per action.
3. **Screen verification loop for desktop actions**: after UI automation,
   re-read screen state and confirm the app actually opened before narrating
   (verify step §9, currently result-level only for some actions).
4. **PPT media**: optional image/diagram pulls into image-kind slides
   (respecting offline mode); deck export presets per audience.
5. **Face-lock unlock flow**: identities table + landmark signatures exist —
   wire "unlock AURA with my face" using stored profiles; store fingerprint
   only conceptually (WebAuthn platform authenticator, no raw biometrics).
6. **Semantic recall in chat**: recallKnowledge results already feed the
   context packet — add user-visible "I remember…" confirmations for stored
   preferences ("Remember that I prefer Brave" → confirmed + used).
7. **AURA-in-AURA**: pair two AURA instances ("your desktop") via the device
   gateway; remote actions through the same honest unavailable-device path.

## Invariants I test before every commit

`test-core`, `test-architecture`, `test-actions`, `test-router`,
`test-doc-agent`, `test-docgen`, `test-bridge-security`, `test-database`,
`test-persistence`, plus full `../tests/run-all.sh` before pushing a wave.
