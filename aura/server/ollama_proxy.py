"""
AURA :: Ollama Proxy
====================
Ollama listens on :11434, AURA's page is served from :8000. Different port
means different ORIGIN, so a browser fetch triggers a CORS preflight that
Ollama rejects unless the user sets OLLAMA_ORIGINS. That is the #1 reason
"Ollama doesn't work" in browser apps.

We remove the problem entirely by proxying:

    browser  ->  http://localhost:8000/ollama/...   (SAME origin, no CORS)
    serve.py ->  http://localhost:11434/...         (server-to-server)

Streaming is preserved chunk-by-chunk so tokens still arrive live.
Also exposes model pulling with real progress, so AURA can install a model
for the user instead of telling them to run a terminal command.
"""

import json
import threading
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor

DEFAULT_OLLAMA = "http://localhost:11434"

# Capability cache: model name -> {"capabilities": [...], "modified_at": str}
# /api/show reads a local manifest, so it is fast, but doing it for every
# model on every status poll would still add avoidable latency. Keyed on
# modified_at so re-pulling a model invalidates its entry automatically.
_CAP_CACHE = {}
_CAP_LOCK = threading.Lock()

# NO HARDCODED MODEL LIST.
#
# This file used to carry a curated FAST_MODELS catalog (qwen2.5:3b,
# llama3.2:3b, phi3.5:3.8b ...). That was a bug: AURA offered and even
# selected models the user had never pulled, and the names drifted from what
# Ollama actually reports. Ollama is the single source of truth — everything
# below is derived from a live `/api/tags` call, which is exactly what
# `ollama list` prints.
#
# The only thing we keep is a *suggestion* list used ONLY when the user has
# zero models installed and explicitly asks AURA to install one. It is never
# used for routing, never shown as "available", and never auto-selected.

SUGGESTED_IF_EMPTY = [
    {"id": "gemma2:2b",  "label": "Gemma 2 2B",  "size_gb": 1.6, "ram_gb": 3,
     "why": "Smallest capable chat model. Near-instant on modest hardware.",
     "recommended": True},
    {"id": "qwen2.5:3b", "label": "Qwen 2.5 3B", "size_gb": 1.9, "ram_gb": 4,
     "why": "Best all-round quality per millisecond."},
    {"id": "qwen2.5-coder:7b", "label": "Qwen 2.5 Coder 7B", "size_gb": 4.7, "ram_gb": 8,
     "why": "Add this only if you want real coding help."},
]


def _req(base, path, method="GET", body=None, timeout=15):
    url = base.rstrip("/") + path
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method,
                               headers={"Content-Type": "application/json"})
    return urllib.request.urlopen(r, timeout=timeout)


def show(model, base=DEFAULT_OLLAMA, timeout=8):
    """
    Ask Ollama what a model can ACTUALLY do.

    /api/show returns a `capabilities` array — ["completion", "vision",
    "tools", "thinking", "embedding"] — computed by Ollama from the model's
    own GGUF metadata (a `vision.block_count` KV means it has a vision
    tower). This is ground truth.

    WHY THIS EXISTS: AURA used to infer "can it see?" from a regex on the
    model NAME. That is unfixable by design — every new multimodal family
    ships under a name nobody has written a pattern for yet, and the user
    is told to download a model they already have. Names are guesses;
    /api/show is the fact.
    """
    try:
        with _req(base, "/api/show", "POST", {"model": model}, timeout) as r:
            return json.loads(r.read())
    except Exception:
        return None


def capabilities(model, base=DEFAULT_OLLAMA, modified_at=None, timeout=8):
    """
    Capabilities for one model, cached. Returns [] when unknown (older
    Ollama builds predate the field) so callers can fall back gracefully.
    """
    key = (model, modified_at)
    with _CAP_LOCK:
        hit = _CAP_CACHE.get(key)
    if hit is not None:
        return hit
    info = show(model, base, timeout=timeout)
    caps = []
    if isinstance(info, dict):
        caps = [str(c).lower() for c in (info.get("capabilities") or [])]
    with _CAP_LOCK:
        if len(_CAP_CACHE) > 200:
            _CAP_CACHE.clear()
        _CAP_CACHE[key] = caps
    return caps


def status(base=DEFAULT_OLLAMA, timeout=8, with_capabilities=True):
    """
    Is Ollama running, and what is ACTUALLY installed?

    This is the single source of truth for model names — the same data
    `ollama list` shows. Nothing here is guessed or hardcoded.

    timeout is 8s (was 3s): a busy Ollama loading a model into VRAM can be
    slow to answer /api/tags, and a premature timeout was being reported to
    the user as "Ollama is not running" while it was plainly running.

    When `with_capabilities` is set, each model is enriched with its real
    capability list from /api/show (concurrently, cached). A failure there
    is non-fatal: the model still appears, just with `caps: []`.
    """
    try:
        with _req(base, "/api/tags", timeout=timeout) as r:
            data = json.loads(r.read())
        models = []
        for m in data.get("models", []):
            # Ollama uses "name" on /api/tags and "model" on /api/ps.
            name = m.get("name") or m.get("model")
            if not name:
                continue
            d = m.get("details") or {}
            models.append({
                "name": name,                       # EXACT string, verbatim
                "size_gb": round(m.get("size", 0) / 1e9, 2),
                "family": d.get("family"),
                "params": d.get("parameter_size"),
                "quant": d.get("quantization_level"),
                "modified_at": m.get("modified_at"),
                "caps": [],
            })
        models.sort(key=lambda x: x["name"])

        if with_capabilities and models:
            # Ask every model what it can do, in parallel. Bounded pool so a
            # 20-model machine doesn't open 20 sockets at once.
            def enrich(entry):
                try:
                    entry["caps"] = capabilities(
                        entry["name"], base,
                        modified_at=entry.get("modified_at"), timeout=timeout)
                except Exception:
                    entry["caps"] = []
            try:
                with ThreadPoolExecutor(max_workers=min(6, len(models))) as pool:
                    list(pool.map(enrich, models))
            except Exception:
                pass    # capability data is a bonus, never a hard dependency

        return {"ok": True, "running": True, "models": models, "count": len(models),
                "names": [m["name"] for m in models],
                "vision": [m["name"] for m in models if "vision" in (m["caps"] or [])],
                "embedding": [m["name"] for m in models if "embedding" in (m["caps"] or [])],
                "tools": [m["name"] for m in models if "tools" in (m["caps"] or [])],
                "thinking": [m["name"] for m in models if "thinking" in (m["caps"] or [])]}
    except urllib.error.URLError as e:
        return {"ok": True, "running": False, "models": [], "names": [],
                "reason": f"Ollama is not reachable at {base} ({getattr(e, 'reason', e)}). "
                          f"Start it with: ollama serve"}
    except Exception as e:
        return {"ok": True, "running": False, "models": [], "names": [], "reason": str(e)}


def catalog(base=DEFAULT_OLLAMA):
    """
    What can the user actually use right now?

    `models` = the real installed list (never a curated guess).
    `suggested` = install candidates, and ONLY when nothing is installed at
    all. Anything already installed is filtered out so we can never suggest
    something the user already has.
    """
    st = status(base)
    installed = [m["name"] for m in st.get("models", [])]
    installed_set = set(installed)

    def already_have(mid):
        if mid in installed_set:
            return True
        bare = mid.split(":")[0]
        return any(i == bare or i == f"{bare}:latest" for i in installed_set)

    suggested = [] if installed else [
        m for m in SUGGESTED_IF_EMPTY if not already_have(m["id"])
    ]

    return {
        "ok": True,
        "running": st.get("running", False),
        "reason": st.get("reason"),
        "models": st.get("models", []),     # REAL installed models
        "installed": sorted(installed),
        "names": sorted(installed),
        "suggested": suggested,
    }


def resolve_model(name, base=DEFAULT_OLLAMA):
    """
    Map a requested model name onto a REAL installed one.

    Guards against the exact bug the user hit: a wrong/misspelled name being
    sent to Ollama, which 404s and surfaces as a confusing failure.

    Returns (resolved_name, note). resolved_name is None when nothing is
    installed at all.
    """
    st = status(base)
    names = st.get("names") or []
    if not names:
        return None, "no models installed"
    if not name:
        return names[0], f"no model specified — using {names[0]}"
    if name in names:
        return name, None
    # "gemma2" → "gemma2:latest" / first gemma2:* tag
    bare = name.split(":")[0].lower()
    for n in names:
        if n.lower() == f"{bare}:latest":
            return n, f"'{name}' resolved to '{n}'"
    for n in names:
        if n.lower().split(":")[0] == bare:
            return n, f"'{name}' is not installed — using '{n}'"
    # Loose contains match, e.g. "coder" → "qwen2.5-coder:7b"
    for n in names:
        if bare in n.lower():
            return n, f"'{name}' is not installed — using '{n}'"
    return names[0], (f"'{name}' is not installed. Installed: {', '.join(names)}. "
                      f"Using '{names[0]}'.")


def proxy_stream(base, path, method, body_bytes, write_chunk):
    """
    Forward a request to Ollama and stream the response back verbatim.
    `write_chunk(bytes)` is called as data arrives.
    @returns (status_code, error_message|None)
    """
    url = base.rstrip("/") + path
    req = urllib.request.Request(
        url, data=body_bytes or None, method=method,
        headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=600) as r:
            while True:
                chunk = r.read(1024)
                if not chunk:
                    break
                write_chunk(chunk)
        return 200, None
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")[:400]
    except urllib.error.URLError as e:
        return 503, (f"Cannot reach Ollama at {base}. Is it running? "
                     f"Start it with:  ollama serve    ({getattr(e, 'reason', e)})")
    except Exception as e:
        return 500, str(e)


def pull_stream(base, model, write_chunk):
    """
    Download a model, streaming ollama's NDJSON progress straight through.
    Lets AURA show a real progress bar instead of a terminal instruction.
    """
    body = json.dumps({"model": model, "stream": True}).encode()
    return proxy_stream(base, "/api/pull", "POST", body, write_chunk)
