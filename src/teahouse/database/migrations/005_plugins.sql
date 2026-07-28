-- 005: Plugin system — plugin registry + isolated encrypted data storage
CREATE TABLE plugins (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    version         TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    enabled         INTEGER NOT NULL DEFAULT 0,
    permissions     TEXT NOT NULL DEFAULT '[]',  -- JSON array of permission slugs
    has_backend     INTEGER NOT NULL DEFAULT 0,
    has_frontend    INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);

CREATE TABLE plugin_data (
    plugin_id   TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key         TEXT NOT NULL,
    value       TEXT NOT NULL,  -- Fernet-encrypted using master_key
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (plugin_id, user_id, key)
);
CREATE INDEX idx_plugin_data_user ON plugin_data(user_id);
