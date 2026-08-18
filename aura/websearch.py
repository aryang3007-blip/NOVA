"""
AURA :: Web Search + Page Reading
=================================
The offline-first research pipeline:

    User asks something
        │
        ├── Offline core / Ollama knows it   → answer immediately, no network
        │
        └── Doesn't know
                │
                ▼
            ddgs  ................ search (no API key, no tracking)
                │
                ▼
            fetch + trafilatura ... read the real pages, strip boilerplate
                │
                ▼
            Ollama ................ reason over the retrieved text
                │
                ▼
              User

WHY trafilatura AND NOT crawl4ai
--------------------------------
crawl4ai is excellent, but it drives a headless Chromium: a ~300 MB install
and a browser process per crawl. AURA is meant to stay light and start
instantly on a modest Windows machine. trafilatura does the part we actually
need — pull the article text out of the HTML soup — in pure Python, in
milliseconds, with no browser. Verified: 4,925 clean characters from a
Wikipedia page in under a second.

ADAPTIVE DEPTH
--------------
Fetching pages is 10-50x slower than reading snippets, so we only do it when
the question needs it. `classify_depth()` decides; "who won X" stays fast,
"explain / compare / how does X work" reads the sources.

EVERY DEPENDENCY IS OPTIONAL. If ddgs or trafilatura is missing, AURA says so
plainly and falls back to opening a search tab — it never pretends to have
searched.

@module websearch
"""

import concurrent.futures
import re
import urllib.error
import urllib.parse
import urllib.request

UA = "Mozilla/5.0 (compatible; AURA/1.0; +local-assistant)"
FETCH_TIMEOUT = 12
MAX_PAGE_BYTES = 2_000_000
MAX_EXTRACT_CHARS = 6000

# ── optional dependencies, probed once ────────────────────────────────────
try:
    from ddgs import DDGS
    _HAS_DDGS = True
    _DDGS_PKG = "ddgs"
except ImportError:
    try:
        from duckduckgo_search import DDGS      # older package name
        _HAS_DDGS = True
        _DDGS_PKG = "duckduckgo-search"
    except ImportError:
        DDGS = None
        _HAS_DDGS = False
        _DDGS_PKG = None

try:
    import trafilatura
    _HAS_TRAFILATURA = True
except ImportError:
    trafilatura = None
    _HAS_TRAFILATURA = False


def capabilities():
    """What can this install actually do? Surfaced honestly in the UI."""
    return {
        "ok": True,
        "search": _HAS_DDGS,
        "read": _HAS_TRAFILATURA,
        "searchPackage": _DDGS_PKG,
        "reason": None if _HAS_DDGS else
                  "Web search needs the 'ddgs' package.  pip install ddgs",
        "readReason": None if _HAS_TRAFILATURA else
                      "Page reading needs 'trafilatura'.  pip install trafilatura",
    }


# Questions that genuinely need the source text, not just a snippet.
_DEEP_PATTERNS = [
    r"\bexplain\b", r"\bwhy\b", r"\bhow (does|do|to|can)\b", r"\bcompare\b",
    r"\bdifference between\b", r"\bpros and cons\b", r"\btutorial\b",
    r"\bin detail\b", r"\bstep[- ]by[- ]step\b", r"\bsummar(y|ise|ize)\b",
    r"\bwhat is the (best|difference)\b", r"\bdocumentation\b", r"\bguide\b",
    r"\breview\b", r"\banalys(e|is)\b", r"\bresearch\b",
]

# Quick factual lookups — snippets are enough and much faster.
_SHALLOW_PATTERNS = [
    r"^who (is|was|won)\b", r"^when (is|was|did)\b", r"^where\b",
    r"\bprice of\b", r"\bscore\b", r"\bweather\b", r"\bcapital of\b",
    r"^what time\b", r"\brelease date\b",
]


def classify_depth(query, forced=None):
    """
    Decide how hard to work on a query.
    @returns 'snippets' | 'read'
    """
    if forced in ("snippets", "read"):
        return forced
    q = (query or "").strip().lower()
    if not q:
        return "snippets"
    for p in _SHALLOW_PATTERNS:
        if re.search(p, q):
            return "snippets"
    for p in _DEEP_PATTERNS:
        if re.search(p, q):
            return "read"
    # Long, specific questions usually deserve the real page.
    return "read" if len(q.split()) >= 7 else "snippets"


def search(query, max_results=6, region="wt-wt", safesearch="moderate"):
    """
    Run a DuckDuckGo search. No API key, no tracking.
    @returns {"ok":bool, "results":[{title,url,snippet}], ...}
    """
    q = (query or "").strip()
    if not q:
        return {"ok": False, "message": "Empty search query.", "results": []}
    if not _HAS_DDGS:
        return {"ok": False, "needsInstall": "ddgs", "results": [],
                "message": "Web search needs the 'ddgs' package.  pip install ddgs"}

    n = max(1, min(int(max_results or 6), 15))
    try:
        with DDGS() as d:
            raw = list(d.text(q, max_results=n, region=region, safesearch=safesearch))
    except Exception as e:
        return {"ok": False, "results": [],
                "message": f"Search failed: {type(e).__name__}: {e}"}

    results = []
    for r in raw:
        url = r.get("href") or r.get("url") or ""
        if not url.startswith(("http://", "https://")):
            continue
        results.append({
            "title": (r.get("title") or url)[:200],
            "url": url,
            "snippet": (r.get("body") or r.get("snippet") or "")[:400],
        })
    return {"ok": True, "query": q, "count": len(results), "results": results}


def _fetch_one(url):
    """Download and extract the readable text of one page."""
    out = {"url": url, "ok": False, "text": "", "title": None, "error": None}
    try:
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme not in ("http", "https"):
            out["error"] = "unsupported scheme"
            return out
        req = urllib.request.Request(url, headers={
            "User-Agent": UA,
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "en",
        })
        with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT) as r:
            ctype = (r.headers.get("Content-Type") or "").lower()
            if "html" not in ctype and "text" not in ctype:
                out["error"] = f"not a web page ({ctype.split(';')[0] or 'unknown'})"
                return out
            raw = r.read(MAX_PAGE_BYTES)
        html = raw.decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        out["error"] = f"HTTP {e.code}"
        return out
    except Exception as e:
        out["error"] = f"{type(e).__name__}"
        return out

    if not _HAS_TRAFILATURA:
        # Crude fallback so the feature still does something useful.
        text = re.sub(r"<script[\s\S]*?</script>|<style[\s\S]*?</style>", " ", html)
        text = re.sub(r"<[^>]+>", " ", text)
        text = re.sub(r"\s+", " ", text).strip()
        out.update(ok=bool(text), text=text[:MAX_EXTRACT_CHARS], degraded=True)
        return out

    try:
        text = trafilatura.extract(html, include_comments=False,
                                   include_tables=True, no_fallback=False)
        meta = trafilatura.extract_metadata(html)
        out["title"] = getattr(meta, "title", None) if meta else None
    except Exception as e:
        out["error"] = f"extract failed: {type(e).__name__}"
        return out

    if not text:
        out["error"] = "no readable article text"
        return out
    out.update(ok=True, text=text[:MAX_EXTRACT_CHARS])
    return out


def fetch_pages(urls, limit=3):
    """Fetch several pages in parallel — sequential fetching is the bottleneck."""
    urls = [u for u in (urls or []) if isinstance(u, str)][:max(1, min(limit, 5))]
    if not urls:
        return []
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(urls)) as ex:
        return list(ex.map(_fetch_one, urls))


def research(query, depth=None, max_results=6, read_count=3):
    """
    The full pipeline: search, optionally read the top pages, and return a
    block of context ready to hand to a local model.

    Returns everything the UI needs to cite sources, so AURA can say WHERE an
    answer came from instead of asserting it.
    """
    mode = classify_depth(query, depth)
    s = search(query, max_results=max_results)
    if not s["ok"]:
        return {**s, "depth": mode, "pages": [], "context": ""}

    results = s["results"]
    pages = []
    if mode == "read" and results:
        pages = fetch_pages([r["url"] for r in results], limit=read_count)

    # Build the context block the model reads.
    parts = []
    good = [p for p in pages if p.get("ok")]
    if good:
        for i, p in enumerate(good, 1):
            title = p.get("title") or next(
                (r["title"] for r in results if r["url"] == p["url"]), p["url"])
            body = p["text"][:2200].strip()
            parts.append(f"[{i}] {title}\n{p['url']}\n{body}")
    else:
        for i, r in enumerate(results[:max_results], 1):
            parts.append(f"[{i}] {r['title']}\n{r['url']}\n{r['snippet']}")

    context = "\n\n".join(parts)
    return {
        "ok": True,
        "query": query,
        "depth": mode,
        "results": results,
        "pages": [{k: v for k, v in p.items() if k != "text"} for p in pages],
        "readCount": len(good),
        "context": context[:12000],
        "sources": [{"n": i + 1, "title": r["title"], "url": r["url"]}
                    for i, r in enumerate(results[:max_results])],
        "degraded": (not _HAS_TRAFILATURA) and mode == "read",
    }
