-- 001: Initial schema — users, api_keys, llm_configs

CREATE TABLE users (
    id          TEXT PRIMARY KEY,
    username    TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL DEFAULT '',
    hashed_password TEXT NOT NULL,
    is_active   INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

CREATE TABLE api_keys (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label       TEXT NOT NULL DEFAULT '',
    key_hash    TEXT NOT NULL,
    prefix      TEXT NOT NULL,
    is_active   INTEGER NOT NULL DEFAULT 1,
    last_used_at INTEGER,
    created_at  INTEGER NOT NULL
);

CREATE TABLE llm_configs (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label       TEXT NOT NULL,
    api_url     TEXT NOT NULL,
    -- api_key is encrypted with the master key; raw key never stored
    encrypted_api_key TEXT NOT NULL,
    api_format  TEXT NOT NULL DEFAULT 'openai',
    model_name  TEXT NOT NULL,
    max_tokens  INTEGER NOT NULL DEFAULT 8192,
    temperature REAL NOT NULL DEFAULT 0.7,
    is_default  INTEGER NOT NULL DEFAULT 0,
    is_enabled  INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

CREATE INDEX idx_api_keys_user ON api_keys(user_id);
CREATE INDEX idx_llm_configs_user ON llm_configs(user_id);
