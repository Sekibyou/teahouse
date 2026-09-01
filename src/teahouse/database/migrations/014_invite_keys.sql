-- 014: Invite keys for invite-only registration (auth.registration_mode == "invite").
-- Admin/super issue invite keys; a prospective user registers with a valid, unused,
-- un-revoked key. On successful registration the key is marked used (used_at/used_by)
-- rather than deleted, preserving an audit trail. Revoking soft-deletes via revoked_at.

CREATE TABLE IF NOT EXISTS invite_keys (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    issued_by TEXT NOT NULL,          -- user id of the admin/super who issued it
    created_at INTEGER NOT NULL,
    used_at INTEGER,                  -- NULL while unused; set when consumed by a registration
    used_by TEXT,                     -- user id that registered with this key
    revoked_at INTEGER,               -- NULL unless revoked by an admin/super
    revoked_by TEXT                   -- user id that revoked it
);
