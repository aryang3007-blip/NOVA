# AURA — Deployment

## 1. Local (full power) — recommended

```bash
python3 serve.py --allow-actions
```

Everything works: camera, mic, gestures, **Ollama with no CORS setup**, and desktop control.

| Flag | Effect |
|---|---|
| `--allow-actions` | Lets AURA open apps, control media/volume, screenshot |
| `--allow-lan` | Also serve on your LAN (phone testing) |
| `--ollama URL` | Point at a non-default Ollama (default `http://localhost:11434`) |
| `8080` | Any bare number sets the port |

**Ollama needs no configuration.** AURA proxies `/api/ollama/*` through its own
server, so the browser never makes a cross-origin request. This is the fix for
the "Ollama doesn't connect" problem — you do **not** need `OLLAMA_ORIGINS`.

---

## 2. Static hosting (Netlify / Vercel / GitHub Pages / S3)

The whole app is static. Upload the folder as-is.

```bash
npx netlify deploy --prod --dir .      # or
npx vercel --prod
```

**What you lose:** `serve.py` isn't running, so there is **no Ollama proxy and
no desktop control**. Users must supply an API key (the setup wizard handles
this). Camera/mic still work because hosts serve over https.

Add `_headers` (Netlify) or equivalent for correct wasm MIME:

```
/*
  Cross-Origin-Opener-Policy: same-origin
/vendor/wasm/*
  Content-Type: application/wasm
```

---

## 3. Docker

```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY . .
EXPOSE 8000
CMD ["python3","serve.py","8000","--allow-lan"]
```

```bash
docker build -t aura . && docker run -p 8000:8000 aura
```

For Ollama in Docker, point AURA at the host:
`--ollama http://host.docker.internal:11434`

> Do **not** pass `--allow-actions` in a container — it would only control the
> container, not your desktop.

---

## 4. Production checklist

- [ ] **HTTPS is mandatory** for camera/mic on any non-localhost domain.
- [ ] Not in an iframe — or the parent must set `allow="camera; microphone"`.
- [ ] `--allow-actions` only on machines you trust; it is 127.0.0.1-only by design.
- [ ] Choose a fast model. For customer-facing latency: `qwen2.5:3b` locally, or **Groq** in the cloud (~300 tok/s).
- [ ] Set `hybridRouting: true` to keep small talk local and cheap.
- [ ] Vendor folder is 44 MB — enable gzip/brotli and long cache headers on `/vendor/*`.

## Latency notes (why these models)

| Setup | First token | Cost |
|---|---|---|
| Groq `llama-3.1-8b-instant` | ~0.2 s | free tier |
| Ollama `qwen2.5:1.5b` | ~0.3 s local | free |
| Ollama `qwen2.5:3b` | ~0.5 s local | free |
| OpenAI `gpt-4o-mini` | ~0.6 s | paid |

All bundled Ollama options are ≤ 6B to match consumer hardware.
