# AURA — Fix & Feature Report

**2685 assertions · 0 failures · 0 TypeScript errors · 0 console errors**

---

# Round 8 — autonomous upgrade pass

You went offline and asked for productivity, not questions. I shipped the two
capabilities I had previously flagged as *newly feasible*, fixed two real bugs
found while testing them, and cleaned the project up.

## ✅ Image understanding — the model can now actually see

Before: the camera described the scene in **text** ("2 hands, 1 face,
detected: laptop") and handed that string to the model. The model never saw a
picture.

Now `/look [question]` captures the frame and sends the real pixels:

```
/look                        → "describe what you see"
/look what am I holding
/look is there a laptop on the desk
```

- `ollama.stream()` takes an `images` array, strips the data-url prefix, and
  attaches it to the **last user message** — where Ollama expects it.
- Routing is explicit: when images are present AURA picks a **vision-capable**
  model rather than letting the speed-first router pick a text model that
  would silently ignore the picture.
- With no vision model installed it says so and names one to pull, instead of
  sending an image into a void.

**Verified end-to-end in a real browser** against a stub Ollama: camera on,
36 KB frame captured, model confirmed receiving 1 image.

```
ollama pull moondream    # 1.7 GB, fast
ollama pull llava:7b     # 4.7 GB, better
```

## ✅ Semantic memory — recall by meaning, not keywords

`VectorStore` embedded nothing; recall was keyword overlap. So "how do I make
the assistant faster" could **not** find a note saying "reducing model
latency" — no shared words.

It now discovers an embedding model in Ollama, embeds through
`/api/ollama/embeddings`, and searches by cosine similarity, with a cache so
identical text is never embedded twice.

| query | finds | shared keywords |
|---|---|---|
| "how do I make the assistant faster" | *reducing model latency on weak hardware* | **none** |
| "what should I cook tonight" | *my favourite pasta recipe* | none |
| "quantum chromodynamics" | nothing | — |

Falls back to keyword search when no embedding model exists, and `kind`
reports which backend is genuinely in use — it never claims semantic search it
isn't doing.

```
ollama pull nomic-embed-text     # 270 MB
```

## 🐛 Two real bugs, found while testing the above

1. **`PluginRegistry.run()` printed the literal string `"null"` in chat.**
   Every command's return value went through `JSON.stringify`, so a command
   returning `null` to mean *"I already streamed my reply"* rendered as the
   word "null". Visible with `/look`, and latent in `/search`.
2. **The engine rendered that null too** — the same bug one layer up.

Both fixed at source, with 4 regression assertions in `test-core`.

> I only found these because I tested the real user path (typing `/look` into
> the composer) rather than calling the API directly. The direct call looked
> fine.

## ✅ Smart home — dropped, as you asked

Removed from the roadmap in `FEATURE_STATUS.md`. It survives on the hidden
Innovations page, but **reframed**: the interesting part was never the switch
flipping, it's that AURA already senses presence and focus. If it ever
happens, that's the angle.

## ✅ Cleanup

- **`PROJECT_MAP.md`** — a one-page index of what lives where. Every file path
  in it is programmatically verified to exist.
- **`.gitignore`** — test artifacts, `__pycache__`, editor cruft.
- **Removed 3 MB** of `../tests/*.png` debug screenshots that are regenerated on
  every run. Release screenshots in `../screenshots/` are untouched.
- **Innovations page** now marks the two ideas that shipped instead of listing
  them as future work.

---

## One thing worth knowing

`test-desktop-ui` failed once during this pass with *"Maths still answered,
not hijacked"*. I chased it down: my stub Ollama exposed **only** a vision
model, so normal routing correctly picked the only chat-capable model
available, and the stub replied "No image was sent."

Against a normal setup it passes 24/24. **It was a test-harness artifact, not
a product bug** — but I verified that rather than assuming it.

---

## Test suite

```
node (651)     test-desktop 140 · test-core 112 · test-models 106 · test-router 88
               test-desktop-tools 37 · test-voice-loop 30 · test-actions 27
               test-vision-embeddings 26 · test-providers 25 · test-architecture 23
               test-live 22 · test-gesture-wave 15
python (126)   test-bridge-security 48 · test-search-automation 44
               test-server-resilience 18 · test-windows-console 8
               test-server-concurrency 8
browser (450)  browser-test 70 · test-integration 70 · test-command-center 55
               test-avatar-providers 51 · test-theming-memory 44
               test-face-recognition 32 · test-vrm-mtoon 29 · test-new-features 24
               test-desktop-ui 24 · test-body 22 · test-guide 19 · test-ollama-live 10
```

## What's left

| Item | Why not |
|---|---|
| Voice cloning / neural TTS | 50–500 MB model + an inference server |
| Offline speech recognition | Whisper locally — same problem |
| Multi-user / cloud sync | Needs the backend AURA deliberately avoids |
| Phoneme-accurate lip-sync | Browsers expose no phoneme timing |
| Native desktop companion | The single largest unlock — would enable `close_app`, deep app scanning and window management |
| Browser extension | A real project with its own manifest and review process |

## When you're back

```powershell
pip install -r requirements.txt
python server/serve.py --allow-actions
```

- `/look what do you see` — with the camera on and a vision model pulled
- Teach it something in **Settings → Memory**, then ask about it in different
  words
- `PROJECT_MAP.md` if you need to find anything
