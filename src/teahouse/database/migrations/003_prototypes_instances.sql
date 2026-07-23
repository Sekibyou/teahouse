-- 003: Prototypes and instances tables
-- Replaces the old folders/workspaces-based model.
-- prototypes.user_id is NULL for system built-in prototypes.

CREATE TABLE prototypes (
    id          TEXT PRIMARY KEY,
    user_id     TEXT REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    source_path TEXT NOT NULL,
    is_builtin  INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

CREATE INDEX idx_prototypes_user ON prototypes(user_id);

CREATE TABLE instances (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    prototype_id  TEXT REFERENCES prototypes(id) ON DELETE SET NULL,
    name          TEXT NOT NULL,
    dir_path      TEXT NOT NULL,
    floor_count   INTEGER NOT NULL DEFAULT 0,
    status        TEXT NOT NULL DEFAULT 'active',
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);

CREATE INDEX idx_instances_user ON instances(user_id);
