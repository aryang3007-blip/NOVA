# 12 · CONVENTIONS & PITFALLS — the rules this project lives by

Collected from the project's own history (including things that already went
wrong and were fixed). Read before changing code.

## Non-negotiable rules

1. **Honesty over pretending.** Never claim a model works from one 503; never
   say a file/image/feature exists when it doesn't; never report success on
   fallback without saying it was a fallback. The UI must say plainly when a
   capability is missing (`pip install …` hints included).
2. **Budget BEFORE wire.** Spend checks (usage_repo) run before any network
   call. A quota hit must never cost money or hang.
3. **AI writes content, never paths.** One path resolver
   (`bridge._resolve_path`) is the only jail. One path-safety rule; never a
   second one.
4. **ONE variablized function per feature.** The popup, CLI and engine call
   the same function (e.g. `services.docgen.service.generate`). No forked
   per-entry-point pipelines.
5. **No build step.** Vanilla ESM + Python stdlib. Don't add npm/compilers.
6. **Deck corruption is unacceptable.** Real OOXML, validated in tests, motion
   only via `animations.apply_features`.
7. **Per-bullet animation** for EVERY text paragraph (it's a stated product
   requirement).
8. **Resolved ≠ embedded** — report both.
9. **Search first, AI second, native last.** VRE mode `smart` is the default.
   Decorative → AI; photo/reference/scientific/historical/person/logo/product
   → search; diagram/chart/icon → native.
10. **Master Controls can never brick the site** (guide 09): fail-open
    everywhere, protected core, routing-layer gating.
11. **`gemini-3.8-flash` stays the preconfigured outline model.** Do not
    unpin. Image models must be Gemini `*-image`; `imagen-3.0-generate-002`
    is dead.
12. **Don't conclude "model doesn't work" from one 503.** Retry rules are
    built in (exactly one for images); treat it as quota evidence.
13. **Keep the boot-error surface the user liked.** Import failures print
    `!! …` and continue; the server must boot without any optional module.
14. **One search system.** `image_sources.py`'s general adapter uses `ddgs`
    directly (accepted deviation) — never reintroduce a second search system
    or merge it with `server/websearch.py`.

## Project pitfalls (each one already bit us)

- **Sandbox snapshot rollback trap.** The Git HEAD can *revert* to a stale
  snapshot while working files keep newer edits. Recovery that works:
  1. Back up your edited files to `/tmp/…`.
  2. `git fetch origin arena/<branch>` (NOT `fetch --all`).
  3. `git reset --hard FETCH_HEAD`.
  4. Restore backups, rerun tests.
  Don't rebuild committed edits; don't build on orphan commits.
- **`/tmp/pw2` venv can be wiped** — recreate with the pip install list from
  guide 11.
- **`_bridge.action` does not exist** — bridge exposes `dispatch(action, params)`.
- **CSS `display` overrides `hidden`.** The CSS file already declares
  `[hidden]{display:none !important}` — keep it, or `data-flag` hiding will
  silently fail only for elements with an explicit display.
- **Don't gate shell-critical bridge calls.** `system_info`, `get_policy`,
  `detect_apps` are used at boot; gating them = brick. Gate user-initiated
  actions only.
- **A hidden feature must be blocked at every entry:** typed intent, wake
  word, STT, launcher, engine tool call, and the server route. CSS hiding is
  never sufficient.
- **Don't let a toggle remove the only way back in** — that's why
  `page.controls` and `panel.chat` are locked.
- **Stale URLs.** The user's `192.168.29.149:8001` is old; verify against the
  live process/port before quoting.
- **Never claim the repo is clean from `git diff --check` alone.** Check
  `git status --short` and run the suites.

## Process

1. Work on `arena/01a05e23-nova` (this session's branch). Never switch
   branches.
2. Test BEFORE committing; re-test after; verify green counts.
3. Live-verify pages over HTTP (`curl` codes + toggle cycles) — don't rely on
   file presence alone.
4. Commit with descriptive history-style messages (e.g.
   `controls: Master Controls page — toggle every feature/page/pipeline,
   unbreakable`), then `git push origin arena/01a05e23-nova`.
5. Reset any flag you flipped (RESET ALL) before finishing, so the shipping
   state is "everything ON".

## Releasing a feature demo ("only working features" policy)

1. Open `/controls`.
2. Turn OFF anything not demo-stable (e.g. `pipe.websearch` offline,
   `dev.imageTest`, `pipe.automation`).
3. Verify each visible page returns 200 and each hidden page returns the
   honest `feature_off` 404.
4. Running the demo: the server must be started with the flags the visible
   features need (`--allow-actions` for desktop things).
5. After the demo: RESET ALL.
