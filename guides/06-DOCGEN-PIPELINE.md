# 06 · DOCGEN — the document generation pipeline

"Make a PowerPoint/Word/Excel" is the flagship feature. It is one canonical
pipeline shared by the terminal (`/doc`), the feature popups, and the AI
engine — never three different implementations.

## The rule that keeps it safe

**The model writes content, never paths.** The AI produces a structured
*outline* (JSON). Python renders that outline to a real OOXML file. The only
path resolver is `bridge._resolve_path` and it jails everything under
`~/Documents/AURA` (config `docFolder`).

## Files

```
aura/services/docgen/
├── outline.py       # prompts, validate(), expand_image_markers()
├── images.py        # AI image generation (providers, keys, budget, pacing)
├── image_sources.py # web/library image search adapters (Wikimedia/Openverse/NASA/general via ddgs)
├── visuals.py       # Visual Resolution Engine: resolve_slide()/resolve_deck()
├── builder.py       # build_pptx/build_xlsx/build_docx/build() — REAL Office files
├── animations.py    # transitions + per-paragraph entrance animations (OOXML timing)
└── service.py       # capabilities() + generate() — the canonical entry
```

Browser side:

```
aura/js/ai/doc-agent.js   # prompt → outline JSON (or honest sketch fallback)
aura/apps/ppt-builder/    # feature popup UI
aura/apps/doc-builder/    # word/excel popup UI
```

## End-to-end flow (PPT example)

```
"make a ppt on quantum computing"
   │
   ▼ browser
js/ai/doc-agent.js outline({kind:'pptx', topic, engine, slides,…})
   │  ← model call (configured outline provider, budget checked BEFORE wire)
   │  provider truth: router reads the CONFIGURED provider; never hardcode
   ▼
validated spec  {title, subtitle, slides:[{title, bullets:[…], notes}] × N}
   │
   ▼ bridge  action="doc_build" {kind, spec, folder, options}
services/docgen/service.generate(kind, spec, folder, resolver, options)
   ├─ options: {theme, transition, animation, images:{enabled,count,
   │           style,provider,model,keyId,mode,sourcePreference}}
   ├─ visuals.resolve_deck(spec, opts, …)  → {slide assignments, report}
   ├─ builder.build_pptx(spec, folder, resolver)
   ├─ animations.apply_features(path, transition, speed, animation)
   └─ honest report {path, embedded_images, failed_images, validation}
   │
   ▼ browser
task card shows path + OPEN; chat footer says WHICH model made it, which
images were embedded vs failed (never implies success on fallback).
```

## Outline

- Browser: `doc-agent.js` — model system prompt is built by one function;
  messages are paired exactly in tests (`test-doc-agent.mjs`).
- `outlineFallback()` = offline template skeleton, honestly labelled
  `source:'offline-template'` — "no model was involved" is said out loud.
- `services/docgen/outline.py` validates the spec (types, counts) and has
  `expand_image_markers()` for `@gen:` prompts.

## Builders — real files only

- `builder.capabilities()` reports availability per format honestly
  (`python-pptx`/`openpyxl`/`python-docx` + install hint).
- `build_pptx/xlsx/docx` produce valid OOXML zips (verified by tests: zip
  contents, `openpyxl`/`python-docx` reloads).
- **Safety rules baked in:**
  - extension forced to match type (`evil.exe` → `.docx` is refused/forced)
  - traversal filenames cannot escape the folder
  - unknown types refused, non-dict specs refused, empty outlines refused
  - spreadsheet cells starting `= + - @` are prefixed (formula injection)
  - existing files are never silently overwritten
  - empty image sources are refused, never embedded

## Animations

- `apply_transitions(path, style='fade', speed='med')` — real OOXML slide
  transitions (`<p:transition>`).
- `apply_entrance(path, effect, shapes_per_slide)` — real entrance effects
  (`<p:timing>`). **Every text paragraph** on a slide gets its own animated
  paragraph (per-bullet animation is a hard requirement), so the deck's
  motion budget is distributed.
- `apply_features(path, transition, speed, animation)` — one call used by
  tests and the service.
- Options values run through a whitelist; anything else falls back to
  `none`/default rather than emitting broken XML.

## Terminal CLI vs popup — same knobs

The interactive `/doc ppt on X` wizard (in `serve.py`) asks the same choices
the popup has: theme, transition, animation, image mode (`--visual-source
smart|web|ai|none`), source preference (`--source auto|nasa|wikimedia|
openverse|general`), audience, slide count. Both then call the same
`service.generate`.

## Honesty requirements (do not regress)

- Fallback outline must say it's a fallback.
- `resolved ≠ embedded`: report `{embedded, failed, native, count,
  sources:{web,ai,native,none}, details}` — a searched/AI image may resolve
  and then fail to embed; that must be reported.
- Deck completes on search failure, AI failure or HTTP 429; quota errors are
  reported once, no endless retries.
- Validation issues are included in the final report.
