-- 008: Director prompt presets + slot binding expansions

CREATE TABLE director_prompt_presets (
    id              TEXT PRIMARY KEY,
    user_id         TEXT REFERENCES users(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    is_builtin      INTEGER NOT NULL DEFAULT 0,
    match_pattern   TEXT,
    template_yaml   TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_director_prompt_presets_user ON director_prompt_presets(user_id);

ALTER TABLE llm_slot_bindings ADD COLUMN profile_id TEXT REFERENCES model_profiles(id) ON DELETE SET NULL;
ALTER TABLE llm_slot_bindings ADD COLUMN prompt_preset_id TEXT REFERENCES director_prompt_presets(id) ON DELETE SET NULL;

ALTER TABLE llm_providers ADD COLUMN model_fetch_url TEXT NOT NULL DEFAULT '';

ALTER TABLE model_profiles ADD COLUMN is_builtin INTEGER NOT NULL DEFAULT 0;
