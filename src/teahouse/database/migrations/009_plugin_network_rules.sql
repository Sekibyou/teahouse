-- 009: Plugin network allowlist — declare (from plugin.json) + user-appended rules,
-- each with an independent enable flag. Declared rules are immutable (enable-only);
-- user rules are fully CRUD-able.

CREATE TABLE plugin_network_rules (
    id          TEXT PRIMARY KEY,
    plugin_id   TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scheme      TEXT NOT NULL DEFAULT 'https',   -- http | https
    host        TEXT NOT NULL,                   -- literal host or *.subdomain
    port        INTEGER,                         -- NULL = scheme default port
    source      TEXT NOT NULL DEFAULT 'declare', -- 'declare' | 'user'
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_plugin_net_rules_plugin ON plugin_network_rules(plugin_id, user_id);

-- Declared rules: one row per (plugin, user, scheme, host, port) — reinstall dedups.
CREATE UNIQUE INDEX uq_plugin_net_declared
    ON plugin_network_rules(plugin_id, user_id, scheme, host, port)
    WHERE source = 'declare';
