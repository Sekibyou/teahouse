-- 013: plugins per-user composite primary key.
--
-- 005 把 plugins.id 建成全局唯一主键；006 只加了 user_id 列却未改主键，
-- 导致同一插件 id 只能被一个用户安装——A 用户装好某插件后，B 用户再导
-- 同 id 的 zip 就撞 `UNIQUE constraint failed: plugins.id`（表现为"装了但
-- 启不了"，卸载 A 后 B 才装得上）。设计意图是插件按用户完全隔离，故将
-- 主键改为 (id, user_id) 复合主键，并把两个引用 plugins(id) 的外键表
-- （plugin_data、plugin_network_rules）对齐为复合外键。
--
-- SQLite 无法 ALTER 改主键/外键，须按 12 步重建法重建三表。全程
-- foreign_keys=OFF，顺序须先把新 plugins（复合主键）就位，供后续复合外键
-- 解析引用。
PRAGMA foreign_keys=OFF;

-- 1) plugins → 复合主键 (id, user_id)
--    历史孤儿行（005 时代、无 user_id 归属）无法按用户管理，此处丢弃。
CREATE TABLE plugins_new (
    id           TEXT NOT NULL,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    version      TEXT NOT NULL,
    description  TEXT NOT NULL DEFAULT '',
    enabled      INTEGER NOT NULL DEFAULT 0,
    permissions  TEXT NOT NULL DEFAULT '[]',  -- JSON array of permission slugs
    has_backend  INTEGER NOT NULL DEFAULT 0,
    has_frontend INTEGER NOT NULL DEFAULT 0,
    source_path  TEXT NOT NULL DEFAULT '',
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    PRIMARY KEY (id, user_id)
);
INSERT INTO plugins_new
    (id, user_id, name, version, description, enabled, permissions,
     has_backend, has_frontend, source_path, created_at, updated_at)
    SELECT id, user_id, name, version, description, enabled, permissions,
           has_backend, has_frontend, source_path, created_at, updated_at
    FROM plugins
    WHERE user_id IS NOT NULL;
DROP TABLE plugins;
ALTER TABLE plugins_new RENAME TO plugins;
CREATE INDEX idx_plugins_user ON plugins(user_id);

-- 2) plugin_data → 复合外键 (plugin_id, user_id)
CREATE TABLE plugin_data_new (
    plugin_id   TEXT NOT NULL,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key         TEXT NOT NULL,
    value       TEXT NOT NULL,  -- Fernet-encrypted using master_key
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (plugin_id, user_id, key),
    FOREIGN KEY (plugin_id, user_id) REFERENCES plugins(id, user_id) ON DELETE CASCADE
);
INSERT INTO plugin_data_new (plugin_id, user_id, key, value, updated_at)
    SELECT plugin_id, user_id, key, value, updated_at FROM plugin_data;
DROP TABLE plugin_data;
ALTER TABLE plugin_data_new RENAME TO plugin_data;
CREATE INDEX idx_plugin_data_user ON plugin_data(user_id);

-- 3) plugin_network_rules → 复合外键 (plugin_id, user_id)
CREATE TABLE plugin_network_rules_new (
    id          TEXT PRIMARY KEY,
    plugin_id   TEXT NOT NULL,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scheme      TEXT NOT NULL DEFAULT 'https',   -- http | https
    host        TEXT NOT NULL,                   -- literal host or *.subdomain
    port        INTEGER,                         -- NULL = scheme default port
    source      TEXT NOT NULL DEFAULT 'declare', -- 'declare' | 'user'
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    FOREIGN KEY (plugin_id, user_id) REFERENCES plugins(id, user_id) ON DELETE CASCADE
);
INSERT INTO plugin_network_rules_new
    (id, plugin_id, user_id, scheme, host, port, source, enabled, created_at, updated_at)
    SELECT id, plugin_id, user_id, scheme, host, port, source, enabled, created_at, updated_at
    FROM plugin_network_rules;
DROP TABLE plugin_network_rules;
ALTER TABLE plugin_network_rules_new RENAME TO plugin_network_rules;
CREATE INDEX idx_plugin_net_rules_plugin ON plugin_network_rules(plugin_id, user_id);
CREATE UNIQUE INDEX uq_plugin_net_declared
    ON plugin_network_rules(plugin_id, user_id, scheme, host, port)
    WHERE source = 'declare';

PRAGMA foreign_key_check;
PRAGMA foreign_keys=ON;
