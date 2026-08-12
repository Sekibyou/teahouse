-- 011: Add max_context to model_profiles for session compact threshold
ALTER TABLE model_profiles ADD COLUMN max_context INTEGER NOT NULL DEFAULT 131072;
