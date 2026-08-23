-- 003_applications_and_tasks.sql: Installed application catalog and task execution records

-- Application Catalog
CREATE TABLE IF NOT EXISTS installed_applications (
    id TEXT PRIMARY KEY,          -- slug: 'whatsapp', 'vscode'
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    icon TEXT,
    aliases TEXT NOT NULL,        -- JSON array of aliases
    launchers TEXT NOT NULL,      -- JSON object of per-platform launchers
    executable_path TEXT,
    web_fallback TEXT,
    verified INTEGER DEFAULT 0,
    source TEXT DEFAULT 'mock',   -- 'mock', 'scan', 'user'
    installed INTEGER DEFAULT 1,
    launch_count INTEGER DEFAULT 0,
    last_launched REAL,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_apps_category ON installed_applications(category);
CREATE INDEX IF NOT EXISTS idx_apps_launch_count ON installed_applications(launch_count);

-- Agent Tasks (Task history and logs)
CREATE TABLE IF NOT EXISTS agent_tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    status TEXT NOT NULL,         -- 'pending', 'running', 'completed', 'failed', 'cancelled'
    target_app TEXT,
    steps_count INTEGER DEFAULT 0,
    max_steps INTEGER DEFAULT 10,
    result_summary TEXT,
    created_at REAL NOT NULL,
    completed_at REAL
);
CREATE INDEX IF NOT EXISTS idx_tasks_created ON agent_tasks(created_at);
