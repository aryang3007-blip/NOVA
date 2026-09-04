-- 005_usage_log.sql: API spend ledger (provider/model/kind/status per call)
-- No secrets here — only who was called, when, and whether it worked.

CREATE TABLE IF NOT EXISTS usage_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL,
    provider TEXT NOT NULL,          -- gemini | openai | anthropic | ...
    model TEXT DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'chat',  -- chat | outline | image | docgen
    status TEXT NOT NULL DEFAULT 'ok',  -- ok | error | blocked | retried
    detail TEXT DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_log(ts DESC);
CREATE INDEX IF NOT EXISTS idx_usage_provider ON usage_log(provider, ts DESC);
CREATE INDEX IF NOT EXISTS idx_usage_kind ON usage_log(kind, ts DESC);
