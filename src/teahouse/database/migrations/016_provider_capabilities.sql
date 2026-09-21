-- 016: Per-provider capability overrides for non-standard request fields.
--
-- Which non-standard body fields an endpoint accepts differs per vendor: the
-- `thinking` knob is a DeepSeek extension that Gemini's OpenAI-compatibility
-- layer rejects outright with 400 "Unknown name thinking". This column holds a
-- small JSON overrides blob (e.g. {"thinking": true}); empty means "no override",
-- so the built-in host table in provider_caps.py decides and shipped-table
-- updates keep reaching existing rows without a migration.
ALTER TABLE llm_providers ADD COLUMN capabilities TEXT NOT NULL DEFAULT '';
