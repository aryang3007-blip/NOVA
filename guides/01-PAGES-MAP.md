# 01 · PAGES MAP — Every page in NOVA right now

All HTML pages are served by `aura/server/serve.py` (the HTTP server). Do
**not** open the HTML files directly with `file://` — camera, microphone and
ES modules require an HTTP origin.

## The pages

| URL | Aliases | File | What it is | Master Controls flag |
|-----|---------|------|------------|----------------------|
| `/` | — | `aura/index.html` | **Main app shell**: chat, avatar, camera vision, gestures, settings modal, dock | `panel.chat` (locked) |
| `/screen` | `/live` | `aura/live.html` | **AURA Live** — full-screen control dashboard (screen share/ask/find/act, desktops, automation) | `page.live` |
| `/phone` | `/companion` | `aura/phone.html` | **Android/phone companion** — pairing page, device control, live status | `page.phone` |
| `/db` | — | `aura/db.html` | **Database manager** — settings editor, schema browser, budget, usage ledger, vault slots, backup/restore | `page.db` |
| `/dev` | — | `aura/dev.html` | **Developer page** — version, release notes, build status | `page.dev` |
| `/dev/image-test.html` | — | `aura/dev/image-test.html` | **Temporary image-production test UI** (labelled as dev-only) — generate one image or one test slide, with provider/model/style | `dev.imageTest` |
| `/controls` | `/master` | `aura/controls.html` | **Master Controls** — turn every feature/page/pipeline on/off, RESET ALL | `page.controls` (**locked**, can never be off) |

That is all of them: **7 pages** (8 if you count the `image-test.html` dev
surface separately — it's listed above either way).

## What is NOT a page

- `/favicon.ico` + friends — icon only.
- `/api/*` — JSON endpoints (see guide 04).
- Static assets — `js/`, `css/`, `apps/`, `vendor/`, `screenshots/` are served
  by `SimpleHTTPRequestHandler` after the explicit routes.

## How a page route is wired (example: `/db`)

```python
# aura/server/serve.py → Handler.do_GET
if path in ("/db", "/db/"):
    if not _feature_on("page.db"):                    # Master Controls gate
        return self._json({"ok": False, "message": "Database manager is turned off in Master Controls.", "code": "feature_off"}, 404)
    with open(os.path.join(ROOT, "db.html"), "rb") as f:
        body = f.read()
    self.send_response(200) ...                       # text/html, no-store
```

`ROOT` is the `aura/` directory. Every page route follows the same pattern.

## Adding a new page (the correct recipe)

1. Create `aura/<name>.html`.
2. Add a route in `Handler.do_GET` (before the final `super().do_GET()`).
   Keep the same shape: open file → 200 with `text/html; charset=utf-8`,
   `Cache-Control: no-store`.
3. Add a flag in `aura/persistence/feature_flags.py` with `"kind": "page"` so
   Master Controls can hide it. The server gate is `_feature_on("page.<name>")`.
4. If it belongs in the shell's UI, add `data-flag="page.<name>"` to its dock
   entry in `index.html`.
5. Add a page-presence assert to `aura/tests/test-features.py` (they follow the
   pattern `os.path.isfile(os.path.join(_UI_DIR, "x.html"))`).
6. Add `<script>` inline blocks to the parse list in
   `aura/tests/test-module-parse.mjs`.

## Where nav lives

- **Main shell dock** — `aura/index.html`, the `<nav class="dock">` block.
  Buttons use `data-panel="..."` for panels, `href="/screen"` for links.
- **Settings modal gear row** — `aura/index.html`, the settings `<header>`:
  🎛 opens `/controls`, ✕ closes.
- **Panels vs pages:** panels (chat/vision/dev/ops/wardrobe) are DOM panels
  inside `index.html`; pages are separate URLs. Both can be hidden by Master
  Controls.
