# 05 · PERSISTENCE — SQLite, config, vault, budget, flags

## Where the data lives

- **DB:** `%LOCALAPPDATA%\AURA\aura.db` (Windows) / `~/.aura/aura.db`
  (elsewhere). Override with `AURA_DB_PATH`.
- **Schema version:** 5. Migrations live in `aura/persistence/migrations/`
  (`001 initial_schema` … `005 usage_log`), applied automatically at boot by
  `persistence/db.py` → `db_manager.initialize()`.
- **Vault:** DPAPI-encrypted credential vault
  (`persistence/vault.py`, `credential_vault`). API keys go here — **never**
  in config rows or the browser.

## Modules

```
aura/persistence/
├── db.py            # connection + migrations + backup/restore
├── vault.py         # credential_vault: set_key/get_key/has_key/profiles
├── feature_flags.py # Master Controls registry (guide 09)
├── api.py           # PersistenceAPIHandler — ALL /api/db/* JSON (no raw SQL)
├── importer.py      # legacy client storage import + wake phrase seeding
└── repositories/    # typed accessors, one per domain
    ├── config_repo.py      # config rows (json-serialised)
    ├── memory_repo.py      # conversations, episodes, knowledge, preferences
    ├── device_repo.py      # paired devices
    ├── wake_repo.py        # wake phrases
    ├── app_repo.py         # app registry / tasks
    ├── permission_repo.py  # action permissions
    └── usage_repo.py       # spend ledger (record/summary/check/clear)
```

**Never write raw SQL from the browser.** The `/db` page is deliberately
read-only for schema + uses only the domain API. There is no SQL-over-HTTP
endpoint at all — that is a hard design decision.

## Domain API (`/api/db/*`, `persistence/api.py`)

`handle_get / handle_post / handle_delete` — each returns `(dict, status)`.

**DB admin:** `status` (path, version, integrity, sizeBytes, vault),
`schema` (tables/columns/rowCount — quoted names), `backup`, `restore`
(auto pre-restore snapshot, returns `preRestoreBackup`), `export`,
`migrate/import-client`.

**Config:** `settings` (GET all / POST `{key,value}` / DELETE `?key=`).
Key regex: `^[A-Za-z0-9._\-]{1,128}$`. Strings that look like JSON
(`{`, `[`, `"`, `true/false/null`, numbers) are parsed back to real types.

**Keys & budget:** `vault` (slots/profiles — never reveals full keys),
`vault/profiles`, `usage` (ledger), `usage/summary`, `usage/budget`
(GET/POST daily caps: requests, images, outline; per-provider split),
`usage/log` (POST records a call).

**Memory:** `memory/conversation`, `memory/conversation/edit`,
`memory/conversation/pin`, `memory/episodes`, `memory/knowledge`,
`memory/preferences`, `memory/identities`, `memory/recall`, `memory/window`.

**Other:** `wake`, `devices`, `apps`, `apps/launch`, `permissions`,
`permissions/revoke-all`, `config`, `flags`, `flags/reset`.

## Budget model (spend safety)

- `usage_repo.check(kind)` is called **before** any network call
  (images, outline, chat).
- `usage_repo.record(provider, model, kind, status, detail)` logs every call
  → `/db` ledger.
- 429/503 gets ONE retry for images (transient quota); a hard cap reached =
  honest "daily image budget reached (used/cap)" **before** the wire.
- Image RPM pacing: `images._pace(key_id, min_interval)` — default 5s between
  calls on the same key. Keys are per-provider and per-purpose, so outline
  and image budgets never share an RPM bucket.

## Vault key slots (strict)

| Purpose | Slot ids |
|---------|----------|
| Chat/outline | `gemini`, `openai`, `openrouter` (provider profile) |
| Images only | `gemini-image`, `openai-image`, `openrouter-image` |

`services/docgen/images.py` reads **only** the images-only slot for the chosen
provider (`_vault_key(keyId)`). The chat key is never used for images.
`openrouter-image` is a strict dedicated model slot (never chat/outline).

## The `/db` page (db.html)

One-stop admin page: status panel (integrity + size), table browser
(read-only), settings key→JSON editor with validation, budget editor, usage
ledger, vault slots display, backup/restore with automatic pre-restore
backup. It is itself a Master Controls page (`page.db`) — turning it off
hides the route at the server, so typing the URL gives an honest 404.
