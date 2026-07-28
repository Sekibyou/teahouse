-- 006: Plugins per-user — add user_id to plugins table, add source_path
ALTER TABLE plugins ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE plugins ADD COLUMN source_path TEXT NOT NULL DEFAULT '';

-- Recreate index for user-scoped queries
CREATE INDEX idx_plugins_user ON plugins(user_id);
