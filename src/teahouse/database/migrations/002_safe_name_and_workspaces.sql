-- 002: Add safe_name to users, add workspaces table

ALTER TABLE users ADD COLUMN safe_name TEXT NOT NULL DEFAULT '';

CREATE TABLE workspaces (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    safe_name   TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

CREATE INDEX idx_workspaces_user ON workspaces(user_id);
