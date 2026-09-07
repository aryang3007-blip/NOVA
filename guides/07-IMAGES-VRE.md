# 07 · IMAGES & the VISUAL RESOLUTION ENGINE

Two rules dominate this area:

1. **The model describes what visual is needed; the backend decides how.**
   Gemini/Nano Banana writes an image *need* ("historic photo of X", "flat
   illustration of Y"); the Visual Resolution Engine (VRE) picks the source.
2. **Search first, AI second, native last.** VRE is default mode `smart`.

## The three sources (priority in smart mode)

| Priority | Source | When |
|----------|--------|------|
| 1 | **Web/library search** | photo/reference/scientific/historical/person/logo/product types |
| 2 | **AI generation** | decorative/fictional/illustration/artwork/concept types |
| 3 | **Native (PPT shapes)** | diagram/chart/icon — or when search+AI failed/blocked |

Source preference chains (per type): `reference = [nasa, wikimedia, openverse, general]`,
`photo = [openverse, wikimedia, general, nasa]`, default `[wikimedia,
openverse, general, nasa]`.

### Type → resolver

- `SEARCH_FIRST = {photo, reference}`
- `AI_ONLY = {illustration, artwork, concept, fictional}`
- `NATIVE = {diagram, chart, icon}`

### Modes

`smart` (resolve by type), `web` (search only → native), `ai` (AI only →
native on failure), `none` (native only). `@gen:` in a prompt forces AI for
that slide. Native reasons are honest: `design / no_search / blocked / quota /
error / mode`.

## Modules

```
aura/services/docgen/
├── images.py        # AI generation: generate(prompt, style, provider, outdir, model, key_fn, urlopen_fn, …)
├── image_sources.py # search adapters: capabilities(), search(type, query, …)
└── visuals.py       # resolve_slide(), resolve_deck(), generate_fn(), download()
```

- `images.generate()` — ONE provider, ONE model, ONE images-only key slot;
  budget check BEFORE wire; 429/503 = one retry; RPM pacing per key; every
  call lands in the usage ledger; honest messages for no-key, dead model,
  non-image response, HTTP error.
- `image_sources.py` — adapters for **Wikimedia Commons**, **Openverse**,
  **NASA**, and a **general ddgs-based adapter**. NOTE: it calls `ddgs`
  directly (it returns image URLs, not text) — this is an accepted deviation;
  do NOT try to merge it into `server/websearch.py` (that returns text
  results). One search system, one general adapter.
- `visuals.download()` — guards: http(s) only, SSRF block, magic-byte check,
  ≤25 MB, ≥256 px, saved inside the deck folder.
- `resolve_deck()` — caps AI images at `images.count` (max 3); returns the
  full report shape below.

## Providers, models, key slots (strict separation)

From `services/manifest.json` + `js/features/registry.js`:

| Provider | Image slot | Models |
|----------|-----------|--------|
| Gemini | `gemini-image` | `gemini-3.1-flash-image` (Nano Banana 2), `gemini-3.1-flash-lite-image`, `gemini-2.5-flash-image`, `gemini-3-pro-image` |
| OpenAI | `openai-image` | `gpt-image-1` |
| OpenRouter | `openrouter-image` | same Google Gemini image models via one key — **image-only slot, never chat/outline** |

**Selection rule:** only Gemini `*-image` models create images. `imagen-3.0`
is dead — never unpin it anywhere. The preconfigured outline model
**`gemini-3.8-flash` stays pinned** — do not unpin.

## VRE report shape (returned to callers + UI)

```
{
  embedded: n, failed: […], native: […],
  count: n,
  sources: {web: n, ai: n, native: n, none: n},
  details: […]
}
```

The deck builder embeds only files it actually verified; the chat footer says
how many images were embedded and lists failed ones. "Resolved ≠ embedded."

## Budget / pacing (already implemented — preserve)

- Daily caps checked BEFORE wire (`usage_repo.check('image')`).
- `min_interval` pacing (default 5 s) between image calls per key.
- On 429: exactly ONE retry; then native fallback; deck still completes.
- `usage_repo` ledger records every attempt incl. `blocked`.

## The dev test harness

`/dev/image-test.html` (temporary, clearly labelled dev surface) → bridge
`image_test` action → `images.generate()` directly. It needs an images-only
key; without one it says exactly where to add it (PPT Builder → Images, or
Settings → Keys & Spend). Lives under Master Controls flag `dev.imageTest`.

## Master Controls interaction

- `pipe.images` OFF → `images.generate()` returns
  `{ok:false, off:true, code:'feature_off'}`; search-first and native visuals
  still work, decks still build.
- `dev.imageTest` OFF → `/dev/image-test.html` 404s honestly; bridge
  `image_test` returns `disabled:true`.
