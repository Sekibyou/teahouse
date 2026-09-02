-- 015: Record plugin source git url on the plugins table.
--
-- Tracks where a git-installed plugin came from, so the frontend can show a
-- "custom plugin" vs "git plugin" badge and offer an update button. zip-imported
-- plugins leave this empty. Written only on git-install confirm (never by the
-- startup scan, which would otherwise blank it); a zip reinstall clears it.
ALTER TABLE plugins ADD COLUMN git_url TEXT NOT NULL DEFAULT '';
