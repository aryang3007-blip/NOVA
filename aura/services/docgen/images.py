"""
AURA :: AI image generation for PPT slides
==========================================
The same callable is used by the app (via the build service) and the terminal:
given a prompt + style, pick the provider (manifest imageProviders) and the
provider's model, call it with the owner's vault key, save the image under the
deck folder and return its path. EVERY failure is honest (no key, HTTP error,
non-image response) — a slide never gets a fake picture.

Provider payloads (wire-verified in tests with an injected urlopen):
  gemini (Nano Banana) → POST /v1beta/models/<model>:generateContent
                         with responseModalities [TEXT, IMAGE]; the image
                         arrives as candidates[].content.parts[].inlineData.
                         (Imagen 3 was shut down Nov 2025 and Imagen 4 in
                         Aug 2026 — the live Gemini image models are the
                         Nano Banana family, e.g. gemini-3.1-flash-image.)
  openai               → POST /v1/images/generations (b64_json)
"""

import base64
import os
import threading
import time
import uuid

from ..registry import image_providers

_MAX_IMG = 8 * 1024 * 1024
_THROTTLE_LOCK = threading.Lock()
_THROTTLE = {}  # key_id -> last request timestamp (RPM pacing)

STYLE_HINTS = {
    "flat illustration": "flat vector illustration, clean shapes, poster quality",
    "photorealistic": "photorealistic, natural light, high detail",
    "3d render": "3d render, soft studio lighting, depth of field",
    "watercolor": "soft watercolor illustration, paper texture",
    "line art": "minimal line art, generous white space",
    "holiday": "festive illustration, warm golden accents, celebratory mood",
}


def providers():
    return image_providers()


def _vault_key(pid):
    try:
        from persistence import credential_vault as _cv
        return _cv.get_key(pid)
    except Exception:
        return None


def _key_id(prov):
    """The vault slot for a provider — the IMAGES-ONLY key, never the chat key.
    Strict separation: images using the same key as chat would share one RPM
    budget (the exact bug: outline + images created 'at once' tripped it)."""
    return str(prov.get("keyId") or prov.get("id") or "").strip()


def availability(key_fn=None):
    """Which image provider has its IMAGES-ONLY key right now."""
    out = []
    for p in providers():
        has = bool((key_fn or _vault_key)(_key_id(p)))
        out.append({**p, "hasKey": has})
    return out


def models_for(pid):
    """The provider's selectable models — manifest is the single source."""
    prov = next((p for p in providers() if p["id"] == pid), None)
    if not prov:
        return []
    return list(prov.get("models") or [{"id": prov.get("model", ""),
                                        "label": prov.get("model", "")}])


def _prompt(style, topic_hint):
    hint = STYLE_HINTS.get(str(style or "").lower().strip())
    base = f"{topic_hint}. {hint}." if hint else str(topic_hint or "").strip()
    return (base + " No text, no watermark, no logos.").strip()


def _log_usage(provider, model, kind, status, detail=""):
    """Spend ledger — fire-and-forget; the ledger must never break a build."""
    try:
        from persistence.repositories import usage_repo
        usage_repo.record(provider, model, kind=kind, status=status,
                          detail=str(detail or "")[:200])
    except Exception:
        pass


def _budget_check(kind="image"):
    """(allowed, info) — True when the call may proceed. Uses the budget
    stored in the same local DB the Keys & Spend panel edits; a cap of 0
    means unlimited. No ledger available → never block (no backend harm)."""
    try:
        from persistence.repositories import usage_repo
        return usage_repo.check(kind)
    except Exception:
        return True, {}


def _clip_err(text, n=110):
    """Provider error bodies are raw JSON — turn them into one short line."""
    s = " ".join(str(text or "").split())
    s = s.replace('"', "'").replace("\\n", " ")
    return s[:n] + ("…" if len(s) > n else "")


def _pace(key_id, min_interval, sleep_fn=time.sleep):
    """RPM guard: never fire two image requests at `key_id` closer than
    min_interval seconds apart (0 = off). `sleep_fn` is the test seam."""
    if min_interval <= 0:
        return False, 0.0
    with _THROTTLE_LOCK:
        now = time.time()
        last = _THROTTLE.get(key_id, 0.0)
        wait = min_interval - (now - last)
        if wait > 0:
            sleep_fn(wait)
            return True, wait
    return False, 0.0


def _mark(key_id):
    """Record that a request was sent on this key's RPM budget."""
    with _THROTTLE_LOCK:
        _THROTTLE[key_id] = time.time()


def _save(data, outdir, mime=""):
    """Save with the right extension per the payload mime/magic bytes."""
    os.makedirs(outdir, exist_ok=True)
    ext = ".png"
    mt = str(mime or "").lower()
    if "jpeg" in mt or "jpg" in mt or data.startswith(b"\xff\xd8"):
        ext = ".jpg"
    elif "webp" in mt or data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        ext = ".webp"
    path = os.path.join(outdir, f"aura-img-{uuid.uuid4().hex[:12]}{ext}")
    with open(path, "wb") as fh:
        fh.write(data)
    return path


def generate(prompt, style="flat illustration", provider="gemini", outdir=None,
             model=None, key_fn=None, urlopen_fn=None, base_override=None,
             retries=1, retry_delay=1.5, min_interval=None, sleep_fn=time.sleep):
    """
    Generate ONE image with the provider's (default or explicitly chosen) model.
    STRICT KEY SEPARATION: the request uses ONLY the provider's images-only
    key (manifest keyId, e.g. gemini-image) — the chat/outline key is never
    read, so outline + images don't share one RPM budget.
    Budget: the daily image cap is checked BEFORE any network call; on 429/503
    the call retries `retries` times (quota spikes are transient); between
    image requests on the same key, min_interval (budget imageIntervalSec,
    default 5s) is enforced so a burst cannot trip the RPM limit. Every call
    lands in the usage ledger.
    Returns {ok, path?, provider?, model?, message}.
    """
    prov = next((p for p in providers() if p["id"] == provider), None)
    if not prov:
        return {"ok": False, "message": f"unknown image provider '{provider}'"}
    choices = (prov.get("models") or [])
    default_model = prov.get("model") or (choices[0]["id"] if choices else "")
    use_model = str(model or default_model or "").strip()
    if choices and use_model and use_model not in {c["id"] for c in choices}:
        return {"ok": False, "message":
                f"unknown {prov['label']} image model '{use_model}'"}
    if not use_model:
        return {"ok": False, "message": f"no image model configured for {provider}"}
    key_id = _key_id(prov)
    key = (key_fn or _vault_key)(key_id)
    if not key:
        return {"ok": False, "message":
                f"no IMAGES-ONLY key for {prov['label']} — add it in the PPT "
                f"Builder → Images section (or Settings → Keys & Spend). It is "
                f"used ONLY for image creation; the chat key is never touched."}

    # ── spend guard: block BEFORE the wire so a quota hit costs nothing ──
    allowed, info = _budget_check("image")
    if not allowed:
        used, cap = info.get("used", 0), info.get("cap", 0)
        msg = (f"daily image budget reached ({used}/{cap}) — the image was NOT "
               f"sent. Raise the limit in Settings → Keys & Spend, or try again tomorrow.")
        _log_usage(key_id, use_model, "image", "blocked", msg)
        return {"ok": False, "blocked": True, "message": msg,
                "provider": provider, "model": use_model, "keyId": key_id}

    # ── RPM pacing: never burst requests on one key ──
    if min_interval is None:
        try:
            from persistence.repositories import usage_repo
            min_interval = float(usage_repo.get_budget().get("imageIntervalSec", 5) or 0)
        except Exception:
            min_interval = 5.0
    paced, waited = _pace(key_id, float(min_interval), sleep_fn=sleep_fn)

    import json
    import urllib.error
    import urllib.request

    full = _prompt(style, prompt)
    mime = ""
    last_err = ""
    attempts = 1 + max(0, int(retries))
    _mark(key_id)  # this key's RPM budget is consumed now
    for attempt in range(attempts):
        try:
            if prov["kind"] == "gemini-image":
                url = (base_override or "https://generativelanguage.googleapis.com/v1beta") \
                    + f"/models/{use_model}:generateContent?key={key}"
                body = json.dumps({
                    "contents": [{"parts": [{"text": full}]}],
                    "generationConfig": {"responseModalities": ["TEXT", "IMAGE"]},
                }).encode()
                req = urllib.request.Request(url, data=body,
                                             headers={"Content-Type": "application/json"})
                resp = json.loads((urlopen_fn or urllib.request.urlopen)(req).read())
                b64 = ""
                for cand in resp.get("candidates") or []:
                    for part in (cand.get("content") or {}).get("parts") or []:
                        inline = part.get("inlineData") or part.get("inline_data") or {}
                        if inline.get("data"):
                            b64 = inline["data"]
                            mime = inline.get("mimeType") or inline.get("mime_type") or ""
                            break
                    if b64:
                        break
            elif prov["kind"] == "imagen":  # legacy Imagen :predict — kept for
                # older manifests; current manifest uses the Nano Banana family.
                url = (base_override or "https://generativelanguage.googleapis.com/v1beta") \
                    + f"/models/{use_model}:predict?key={key}"
                body = json.dumps({"instances": [{"prompt": full}],
                                   "parameters": {"sampleCount": 1}}).encode()
                req = urllib.request.Request(url, data=body,
                                             headers={"Content-Type": "application/json"})
                resp = json.loads((urlopen_fn or urllib.request.urlopen)(req).read())
                b64 = ((resp.get("predictions") or [{}])[0].get("bytesBase64Encoded") or "")
            elif prov["kind"] == "openai-images":
                url = "https://api.openai.com/v1/images/generations"
                body = json.dumps({"model": use_model, "prompt": full, "n": 1,
                                   "size": "1024x1024", "response_format": "b64_json"}).encode()
                req = urllib.request.Request(url, data=body, headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {key}"})
                resp = json.loads((urlopen_fn or urllib.request.urlopen)(req).read())
                b64 = (resp.get("data") or [{}])[0].get("b64_json") or ""
            else:
                return {"ok": False, "message": f"unsupported image provider kind '{prov['kind']}'"}
            break  # succeeded
        except urllib.error.HTTPError as e:
            last_err = f"{prov['label']} HTTP {e.code}: {_clip_err(e.read().decode('utf-8', 'ignore'))}"
            # 429/503 are transient quota/spike errors — retry with backoff.
            if e.code in (429, 503) and attempt < attempts - 1:
                time.sleep(retry_delay * (attempt + 1))
                continue
            _log_usage(key_id, use_model, "image", "error", last_err)
            return {"ok": False, "message": last_err}
        except Exception as e:
            last_err = f"{prov['label']} failed: {_clip_err(e)}"
            _log_usage(key_id, use_model, "image", "error", last_err)
            return {"ok": False, "message": last_err}

    if not b64:
        _log_usage(key_id, use_model, "image", "error", "no image data")
        return {"ok": False, "message": f"{prov['label']} returned no image data"}
    try:
        data = base64.b64decode(b64)
    except Exception as e:
        _log_usage(key_id, use_model, "image", "error", "bad base64")
        return {"ok": False, "message": f"{prov['label']} returned bad base64: {e}"}
    if len(data) > _MAX_IMG:
        _log_usage(key_id, use_model, "image", "error", "too large")
        return {"ok": False, "message": f"generated image too large ({len(data)} bytes)"}
    try:
        path = _save(data, outdir or os.path.expanduser("~/Documents/AURA/images"), mime)
    except Exception as e:
        _log_usage(key_id, use_model, "image", "error", f"save: {e}")
        return {"ok": False, "message": f"could not save image: {e}"}
    _log_usage(key_id, use_model, "image", "ok", f"{len(data)} bytes")
    return {"ok": True, "path": path, "provider": provider, "model": use_model,
            "keyId": key_id, "paced": paced, "bytes": len(data),
            "mime": mime or "image/png"}
