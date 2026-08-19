-- 012: Add role column to users (super / admin / user)
-- Role hierarchy: super (fixed username 'admin', undelatable/unmovable),
-- admin (can manage regular users), user (self-service only).
-- Existing admin account is promoted to super.

ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user';

UPDATE users SET role = 'super' WHERE username = 'admin' AND is_active = 1;
