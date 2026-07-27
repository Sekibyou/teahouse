-- 004: LLM model slot system — providers, models, profiles, slot bindings
-- Replaces the flat llm_configs table with a three-layer architecture.

-- Provider: API endpoint + encrypted key + default api_format
CREATE TABLE llm_providers (
    id                  TEXT PRIMARY KEY,
    user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name                TEXT NOT NULL,
    api_url             TEXT NOT NULL,
    encrypted_api_key   TEXT NOT NULL,
    api_format          TEXT NOT NULL DEFAULT 'openai',  -- openai / openai_strict / anthropic
    is_enabled          INTEGER NOT NULL DEFAULT 1,
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL
);
CREATE INDEX idx_llm_providers_user ON llm_providers(user_id);

-- Model: references a provider, stores model_name, binds to a profile
CREATE TABLE llm_models (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,       -- display name
    provider_id     TEXT NOT NULL REFERENCES llm_providers(id) ON DELETE CASCADE,
    model_name      TEXT NOT NULL,       -- actual model identifier sent to API
    profile_id      TEXT REFERENCES model_profiles(id) ON DELETE SET NULL,
    is_enabled      INTEGER NOT NULL DEFAULT 1,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_llm_models_user ON llm_models(user_id);
CREATE INDEX idx_llm_models_provider ON llm_models(provider_id);

-- ModelProfile: parameter presets with optional regex match_pattern
CREATE TABLE model_profiles (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    match_pattern   TEXT,                -- regex for auto-matching model names, nullable
    temperature     REAL NOT NULL DEFAULT 0.7,
    max_tokens      INTEGER NOT NULL DEFAULT 8192,
    top_p           REAL,
    frequency_penalty REAL,
    presence_penalty  REAL,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_model_profiles_user ON model_profiles(user_id);

-- Slot bindings: two fixed slots per user (director, writer)
CREATE TABLE llm_slot_bindings (
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    slot_id         TEXT NOT NULL,       -- 'director' | 'writer'
    model_id        TEXT REFERENCES llm_models(id) ON DELETE SET NULL,
    updated_at      INTEGER NOT NULL,
    PRIMARY KEY (user_id, slot_id)
);
