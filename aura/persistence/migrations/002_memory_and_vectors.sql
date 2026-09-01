-- 002_memory_and_vectors.sql: Conversations, knowledge docs, vector embeddings, episodic memories, face identities

-- Conversation Messages
CREATE TABLE IF NOT EXISTS conversation_messages (
    id TEXT PRIMARY KEY,          -- format: {timestamp}-{role} or uuid
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,           -- 'user', 'assistant', 'system'
    content TEXT NOT NULL,
    pinned INTEGER DEFAULT 0,
    edited_at REAL,
    created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conv_session ON conversation_messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_conv_pinned ON conversation_messages(pinned);

-- Knowledge Base Documents
CREATE TABLE IF NOT EXISTS knowledge_documents (
    id TEXT PRIMARY KEY,
    title TEXT,
    text TEXT NOT NULL,
    source TEXT DEFAULT 'user',
    tags TEXT,                    -- JSON array of tags
    metadata TEXT,                -- JSON object
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_knowledge_created ON knowledge_documents(created_at);

-- Document Vector Embeddings (stored as IEEE 754 float binary BLOB)
CREATE TABLE IF NOT EXISTS document_embeddings (
    doc_id TEXT PRIMARY KEY,
    model TEXT NOT NULL,          -- e.g. 'nomic-embed-text'
    dimensions INTEGER NOT NULL,
    embedding BLOB NOT NULL,      -- Packed binary float32 array
    created_at REAL NOT NULL,
    FOREIGN KEY(doc_id) REFERENCES knowledge_documents(id) ON DELETE CASCADE
);

-- Episodic Memories
CREATE TABLE IF NOT EXISTS episodic_memories (
    id TEXT PRIMARY KEY,
    event TEXT NOT NULL,
    why TEXT,
    source TEXT,
    created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_episodes_created ON episodic_memories(created_at);

-- User Face Signatures (Biometric landmark ratios)
CREATE TABLE IF NOT EXISTS user_identities (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    signature TEXT NOT NULL,      -- JSON array of 25 normalized geometric floats
    samples_count INTEGER DEFAULT 3,
    enrolled_at REAL NOT NULL,
    updated_at REAL NOT NULL
);
