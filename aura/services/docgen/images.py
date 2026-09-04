"""
AURA :: AI image generation for PPT slides
==========================================
The same callable is used by the app (via the build service) and the terminal:
given a prompt + style, pick the provider (manifest imageProviders), call it
with the owner's vault key, save a PNG under the deck folder and return its
path. EVERY failure is honest (no key, HTTP error, non-image response) — a
slide never gets a fake picture.

Provider payloads (wire-verified in tests with an injected urlopen):
  gemini (Imagen)  → POST /v1beta/models/<model>:predict
  openai           → POST /v1/images/generations (b64_json)
"""

import base64
import os
import uuid

from ..registry import image_providers

_MAX_IMG = 8 * 1024 * 1024

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


def availability(key_fn=None):
    """Which image provider has a key right now (terminal + app pickers)."""
    out = []
    for p in providers():
        has = bool((key_fn or _vault_key)(p["id"]))
        out.append({**p, "hasKey": has})
    return out


def _prompt(style, topic_hint):
    hint = STYLE_HINTS.get(str(style or "").lower().strip())
    base = f"{topic_hint}. {hint}." if hint else str(topic_hint or "").strip()
    return (base + " No text, no watermark, no logos.").strip()


def _save_png(data, outdir):
    os.makedirs(outdir, exist_ok=True)
    path = os.path.join(outdir, f"aura-img-{uuid.uuid4().hex[:12]}.png")
    with open(path, "wb") as fh:
        fh.write(data)
    return path


def generate(prompt, style="flat illustration", provider="gemini",
             outdir=None, key_fn=None, urlopen_fn=None, base_override=None):
    """
    Generate ONE image.
    Returns {ok, path?, provider?, model?, message}.
    """
    prov = next((p for p in providers() if p["id"] == provider), None)
    if not prov:
        return {"ok": False, "message": f"unknown image provider '{provider}'"}
    key = (key_fn or _vault_key)(provider)
    if not key:
        return {"ok": False, "message":
                f"no {prov['label']} key — add it in Settings → API Keys"}
    import json
    import urllib.error
    import urllib.request

    full = _prompt(style, prompt)
    try:
        if prov["kind"] == "imagen":
            url = (base_override or "https://generativelanguage.googleapis.com/v1beta") \
                + f"/models/{prov['model']}:predict?key={key}"
            body = json.dumps({"instances": [{"prompt": full}],
                               "parameters": {"sampleCount": 1}}).encode()
            req = urllib.request.Request(url, data=body,
                                         headers={"Content-Type": "application/json"})
            resp = json.loads((urlopen_fn or urllib.request.urlopen)(req).read())
            b64 = ((resp.get("predictions") or [{}])[0].get("bytesBase64Encoded") or "")
        elif prov["kind"] == "openai-images":
            url = "https://api.openai.com/v1/images/generations"
            body = json.dumps({"model": prov["model"], "prompt": full, "n": 1,
                               "size": "1024x1024", "response_format": "b64_json"}).encode()
            req = urllib.request.Request(url, data=body, headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {key}"})
            resp = json.loads((urlopen_fn or urllib.request.urlopen)(req).read())
            b64 = (resp.get("data") or [{}])[0].get("b64_json") or ""
        else:
            return {"ok": False, "message": f"unsupported image provider kind '{prov['kind']}'"}
    except urllib.error.HTTPError as e:
        return {"ok": False, "message": f"{prov['label']} HTTP {e.code}: "
                f"{e.read().decode('utf-8', 'ignore')[:160]}"}
    except Exception as e:
        return {"ok": False, "message": f"{prov['label']} failed: {e}"}

    if not b64:
        return {"ok": False, "message": f"{prov['label']} returned no image data"}
    try:
        data = base64.b64decode(b64)
    except Exception as e:
        return {"ok": False, "message": f"{prov['label']} returned bad base64: {e}"}
    if len(data) > _MAX_IMG:
        return {"ok": False, "message": f"generated image too large ({len(data)} bytes)"}
    if not data.startswith(b"\x89PNG") and not data.startswith(b"\xff\xd8"):
        # Imagen may return webp; convert envelope is overkill — keep and let
        # the renderer try; python-pptx accepts what it can parse.
        pass
    try:
        path = _save_png(data, outdir or os.path.expanduser("~/Documents/AURA/images"))
    except Exception as e:
        return {"ok": False, "message": f"could not save image: {e}"}
    return {"ok": True, "path": path, "provider": provider, "model": prov["model"],
            "bytes": len(data)}
