-- 004_credential_metadata.sql: Provider metadata and credential references (no plaintext secrets)

CREATE TABLE IF NOT EXISTS provider_configs (
    provider_id TEXT PRIMARY KEY, -- 'openai', 'anthropic', 'gemini', 'groq', 'openrouter', 'ollama'
    label TEXT NOT NULL,
    default_model TEXT,
    base_url TEXT,
    is_enabled INTEGER DEFAULT 1,
    has_credential INTEGER DEFAULT 0,
    last_tested_at REAL,
    updated_at REAL NOT NULL
);
