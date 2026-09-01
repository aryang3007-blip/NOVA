-- 001_initial_schema.sql: Core system settings, devices, permissions, wake words, preferences

-- Core System Configuration (non-secret config)
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,          -- JSON encoded value
    updated_at REAL NOT NULL
);

-- Paired Devices (Companion & Host)
CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,          -- e.g. 'android-001', 'windows-host'
    name TEXT NOT NULL,
    platform TEXT NOT NULL,       -- 'android', 'ios', 'windows', 'macos', 'linux'
    kind TEXT NOT NULL,           -- 'phone', 'desktop'
    token TEXT NOT NULL,          -- Authenticated device token
    capabilities TEXT NOT NULL,   -- JSON array: ["open_url", "vibrate", ...]
    paired_at REAL NOT NULL,
    last_seen REAL NOT NULL,
    battery REAL,
    latency_ms REAL,
    is_active INTEGER DEFAULT 1,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_devices_last_seen ON devices(last_seen);

-- Desktop Security Permissions
CREATE TABLE IF NOT EXISTS permissions (
    id TEXT PRIMARY KEY,          -- e.g. 'launch_apps', 'file_system'
    granted INTEGER NOT NULL,     -- 1 or 0
    source TEXT NOT NULL,         -- 'user', 'setup'
    updated_at REAL NOT NULL
);

-- Wake Phrases
CREATE TABLE IF NOT EXISTS wake_phrases (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phrase TEXT NOT NULL,
    model TEXT,
    threshold REAL DEFAULT 0.55,
    enabled INTEGER DEFAULT 1,
    updated_at REAL NOT NULL
);

-- User Preferences & Durable Facts
CREATE TABLE IF NOT EXISTS user_preferences (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,          -- JSON encoded value
    source TEXT DEFAULT 'user',
    confidence REAL DEFAULT 1.0,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);
