-- 010: Per-user JSON preferences blob (e.g. { "reasoning_effort": "high" }).
-- Stored on users so the main session's "thinking strength" default is a
-- global user-level setting shared across instances, while child sessions keep
-- their own per-session override in .sessions/<sid>.meta.json.

ALTER TABLE users ADD COLUMN preferences TEXT;
