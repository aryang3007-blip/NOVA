"""
AURA :: Image Sources (Visual Resolution Engine, step 1)
========================================================
Public-API image discovery for the PPT Builder's search-first pipeline.
NO scraping, NO API keys: every adapter talks to a documented public API and
returns candidate records with license/attribution info so credits can travel
with the visual.

Sources (no hard-coded assets, no single-source dependency):
  wikimedia  → Wikimedia Commons API  (CC/PD, attribution metadata)
  openverse  → Openverse API          (CC-licensed, no key for basic use)
  nasa       → NASA Images API        (public domain, authoritative)
  general    → ddgs image search      (the SAME package AURA's websearch uses)

`search()` merges sources in preference order and `pick()` scores candidates;
`download()` validates before saving (http(s) only, no private IPs, magic-byte
check, min dimensions) — a candidate that fails validation is never embedded.

Every function is network-tolerant: a failing source is reported, never raised,
so a deck can always fall through to AI generation or a native visual.
"""

import hashlib
import ipaddress
import json
import os
import re
import socket
import urllib.error
import urllib.parse
import urllib.request

UA = "Mozilla/5.0 (compatible; NOVA/1.0; +local-assistant)"
FETCH_TIMEOUT = 15
MAX_BYTES = 25 * 1024 * 1024
MIN_DIM = 256
_IMAGE_EXT = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"}
_IMAGE_MAGIC = (
    (b"\x89PNG\r\n\x1a\n", "png"),
    (b"\xff\xd8\xff", "jpeg"),
    (b"GIF87a", "gif"), (b"GIF89a", "gif"),
    (b"RIFF", "webp"),
)

SOURCES = [
    {"id": "nasa", "label": "NASA (authoritative)"},
    {"id": "wikimedia", "label": "Wikimedia Commons"},
    {"id": "openverse", "label": "Openverse (CC)"},
    {"id": "general", "label": "General web search"},
]


def capabilities():
    """What image discovery can do in this install (honest, like websearch)."""
    avail = {}
    for s in SOURCES:
        avail[s["id"]] = _adapter_available(s["id"])
    return {"ok": any(avail.values()), "sources": SOURCES, "available": avail}


def _adapter_available(sid):
    try:
        if sid == "general":
            from ddgs import DDGS  # noqa: F401 (probe only)
            return True
        return True  # service APIs need no dependency beyond stdlib
    except Exception:
        return False


# ── adapters ────────────────────────────────────────────────────────────────

def _get_json(url, params=None, timeout=FETCH_TIMEOUT):
    """One JSON GET with a browser-ish UA. Raises on failure (callers catch)."""
    if params:
        url = f"{url}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={
        "User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def _strip_html(s):
    return re.sub(r"<[^>]+>", " ", str(s or "")).strip()


def _wikimedia(query, limit=6):
    """Commons file search → direct file URLs + license/attribution."""
    data = _get_json("https://commons.wikimedia.org/w/api.php", {
        "action": "query", "format": "json", "generator": "search",
        "gsrnamespace": "6", "gsrlimit": str(limit),
        "gsrsearch": f"filetype:bitmap {query}",
        "prop": "imageinfo",
        "iiprop": "url|size|mime|extmetadata",
        "iiurlwidth": "1600",
    })
    out = []
    for page in (data.get("query", {}).get("pages") or {}).values():
        for ii in page.get("imageinfo") or []:
            url = ii.get("thumburl") or ii.get("url")
            if not url or not url.startswith("http"):
                continue
            meta = ii.get("extmetadata") or {}
            lic = _strip_html(meta.get("LicenseShortName", {}).get("value", ""))
            artist = _strip_html(meta.get("Artist", {}).get("value", ""))
            title = _strip_html(meta.get("ObjectName", {}).get("value", "")) \
                or _strip_html(page.get("title", "")).replace("File:", "")
            attribution = " · ".join(x for x in (artist, lic or "Wikimedia Commons") if x)
            out.append({
                "url": url, "page_url": ii.get("descriptionurl") or "",
                "title": title[:200], "source": "wikimedia",
                "license": lic or "see source", "attribution": attribution or "Wikimedia Commons",
            })
    return out


def _openverse(query, limit=6):
    """Openverse (CC search) — public API, no key for basic use."""
    data = _get_json("https://api.openverse.org/v1/images/", {
        "q": query, "page_size": str(limit)})
    out = []
    for r in data.get("results") or []:
        url = r.get("url")
        if not url or not str(url).startswith("http"):
            continue
        lic = str(r.get("license") or "").upper()
        if r.get("license_version"):
            lic += f" {r['license_version']}"
        creator = r.get("creator") or ""
        attribution = " · ".join(x for x in (creator, lic or "CC") if x)
        out.append({
            "url": str(url), "page_url": r.get("foreign_landing_url") or "",
            "title": (r.get("title") or "")[:200], "source": "openverse",
            "license": lic or "see source", "attribution": attribution or "Openverse",
        })
    return out


def _nasa(query, limit=4):
    """NASA Images API (public domain). Two hops: search → asset list."""
    data = _get_json("https://images-api.nasa.gov/search", {
        "q": query, "media_type": "image"})
    out = []
    for item in (data.get("collection", {}).get("items") or [])[:limit]:
        asset = (item.get("href") or "")
        meta = (item.get("data") or [{}])[0]
        nasa_id = meta.get("nasa_id") or ""
        if not nasa_id:
            continue
        try:
            listing = _get_json(f"https://images-api.nasa.gov/asset/{nasa_id}")
            urls = [x.get("href") for x in listing.get("collection", {}).get("items", [])]
        except Exception:
            urls = [asset]
        url = next((u for u in urls if u and re.search(r"\.(jpe?g|png|gif)(\?|$)", u, re.I)), None)
        if not url:
            continue
        out.append({
            "url": url, "page_url": asset or "",
            "title": (meta.get("title") or "").strip()[:200],
            "source": "nasa", "license": "Public Domain",
            "attribution": f"{meta.get('title') or 'NASA'} — NASA (Public Domain) — {nasa_id}",
        })
    return out


def _general(query, limit=6):
    """ddgs image search — the same package AURA's websearch module already
    depends on (no second search system, no API key)."""
    from ddgs import DDGS
    out = []
    with DDGS() as d:
        for r in list(d.images(query, max_results=limit))[:limit]:
            url = r.get("image") or r.get("thumbnail") or ""
            if not str(url).startswith("http"):
                continue
            out.append({
                "url": str(url), "page_url": r.get("url") or "",
                "title": (r.get("title") or "")[:200], "source": "general",
                "license": "verify before reuse",
                "attribution": r.get("title") or "General web search",
            })
    return out


_ADAPTERS = {"wikimedia": _wikimedia, "openverse": _openverse,
             "nasa": _nasa, "general": _general}

# Preference chains: scientific/reference → authoritative first; photos →
# CC/reference; anything else → try CC then general. `preference` selects the
# leader; the rest follow so no single source can become a hard dependency.
_CHAINS = {
    "reference": ["nasa", "wikimedia", "openverse", "general"],
    "photo": ["openverse", "wikimedia", "general", "nasa"],
    "default": ["wikimedia", "openverse", "general", "nasa"],
}
_LEADER = {"nasa": "reference", "wikimedia": "default", "openverse": "photo",
           "general": "default", "auto": "default"}


def search(query, preference="auto", kind="photo", max_results=8):
    """
    Discover candidate images across sources in preference order.
    Returns {"ok", "query", "count", "results":[...], "notes":[...]} — never
    raises; a dead network/source is an honest note, not an exception.
    """
    q = str(query or "").strip()
    if not q:
        return {"ok": False, "message": "Empty image search query.", "count": 0,
                "results": [], "notes": []}
    chain = list(_CHAINS.get(str(preference).lower(), _CHAINS["default"]))
    leader = str(preference or "auto").lower()
    if leader in _LEADER and _LEADER[leader] != "default":
        chain = list(_CHAINS[_LEADER[leader]])
    # rotate so the requested leader comes first without dropping others
    if leader in chain:
        chain = [leader] + [s for s in chain if s != leader]

    results, seen, notes = [], set(), []
    for sid in chain:
        fn = _ADAPTERS.get(sid)
        if not fn or not _adapter_available(sid):
            notes.append(f"{sid}: unavailable")
            continue
        try:
            rows = fn(q)
        except Exception as e:
            notes.append(f"{sid}: {type(e).__name__}")
            continue
        for r in rows:
            if r.get("url") in seen:
                continue
            seen.add(r["url"])
            results.append(r)
        if len(results) >= max_results:
            break
    results = results[:max_results]
    return {"ok": bool(results), "query": q, "count": len(results),
            "results": results, "notes": notes}


def _looks_like_image(url):
    path = urllib.parse.urlparse(str(url)).path.lower()
    return os.path.splitext(path)[1] in _IMAGE_EXT


def _blocked_host(host):
    """SSRF guard: only public HTTP(S) hosts may be contacted."""
    try:
        infos = socket.getaddrinfo(host, None)
    except Exception:
        return True
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local \
                or ip.is_multicast or ip.is_reserved or ip.is_unspecified:
            return True
    return False


def download(url, outdir, max_bytes=MAX_BYTES, timeout=FETCH_TIMEOUT,
             min_dim=MIN_DIM):
    """
    Validate + download one candidate image to outdir.
    Returns (path|None, error|None, meta). Errors are strings — never raises.
    """
    try:
        parsed = urllib.parse.urlparse(str(url or ""))
        if parsed.scheme not in ("http", "https"):
            return None, "unsupported scheme", {}
        if not parsed.hostname or _blocked_host(parsed.hostname):
            return None, "host not allowed (private/local)", {}
        req = urllib.request.Request(url, headers={"User-Agent": UA,
                                                   "Accept": "image/*,*/*;q=0.8"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = r.read(max_bytes + 1)
        if len(data) > max_bytes:
            return None, f"image too large ({len(data)} bytes)", {}
        if not data:
            return None, "empty response", {}
        kind = None
        for magic, name in _IMAGE_MAGIC:
            if data.startswith(magic):
                kind = name
                break
        if kind is None:
            return None, "not a recognised image format", {}
        from .builder import _image_px
        w, h = _image_px_bytes(data)
        if w and h and (w < min_dim or h < min_dim):
            return None, f"image too small ({w}x{h})", {}
        os.makedirs(outdir, exist_ok=True)
        name = hashlib.sha1(str(url).encode()).hexdigest()[:16] + f".{kind}"
        path = os.path.join(outdir, name)
        # never clobber: identical URL → identical bytes; write anyway.
        with open(path, "wb") as fh:
            fh.write(data)
        return path, None, {"bytes": len(data), "width": w, "height": h,
                            "mime": f"image/{'jpeg' if kind == 'jpeg' else kind}"}
    except urllib.error.HTTPError as e:
        return None, f"HTTP {e.code}", {}
    except Exception as e:
        return None, f"{type(e).__name__}: {e}", {}


def _image_px_bytes(data):
    """Pure-python dimensions from raw bytes (PNG/JPEG/GIF), no file needed."""
    import struct
    head = data[:64]
    try:
        if head[:8] == b"\x89PNG\r\n\x1a\n" and head[12:16] == b"IHDR":
            w, h = struct.unpack(">II", head[16:24])
            return int(w), int(h)
        if head[:3] == b"\xff\xd8\xff":
            i, n = 2, len(head)
            while i < n:
                if head[i] != 0xFF or i + 9 > n:
                    i += 1
                    continue
                marker = head[i + 1]
                if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7,
                              0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                    h, w = struct.unpack(">HH", head[i + 5:i + 9])
                    return int(w), int(h)
                seg = struct.unpack(">H", head[i + 2:i + 4])[0]
                i += 2 + seg
        if head[:6] in ("GIF87a", "GIF89a"):
            w, h = struct.unpack("<HH", head[6:10])
            return int(w), int(h)
    except Exception:
        pass
    return None, None


def pick(results, query, max_attempts=3):
    """Score candidates and return the best `max_attempts` to try downloading.
    Relevance = query tokens present in the title + source authority boost."""
    tokens = [t for t in re.split(r"\W+", str(query or "").lower())
              if len(t) > 2]
    scored = []
    for r in results or []:
        title = str(r.get("title") or "").lower()
        score = 0
        for t in tokens[:6]:
            if t in title:
                score += 3
        if r.get("source") == "nasa":
            score += 2          # authoritative reference imagery
        if r.get("license") and r["license"] not in ("verify before reuse",):
            score += 1
        if _looks_like_image(r.get("url")):
            score += 1
        scored.append((score, r))
    scored.sort(key=lambda x: x[0], reverse=True)
    return [r for _, r in scored[:max_attempts]]
