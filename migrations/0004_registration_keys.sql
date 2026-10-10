-- 0004_registration_keys.sql — Onboarding: registration_keys (Phase 1)
-- Creates the registration_keys table. This table is owned by the onboarding module
-- (per .claude/rules/architecture.md §Persistence ownership).
--
-- Registration keys are invite codes that administrators create for new user registration.
-- The code itself is never stored in plaintext — only the SHA-256 hash.
-- R-DATA-001: code_hash is case-insensitive (hex string).
--
-- Invariants:
-- - max_uses >= 1 (enforced by CHECK constraint)
-- - used_count starts at 0 and increments atomically when the key is used
-- - expired_at can be NULL (keys can be valid indefinitely)
-- - revoked_at NULL means the key is active; set to timestamp to revoke
CREATE TABLE IF NOT EXISTS registration_keys (
  id          TEXT PRIMARY KEY,
  code_hash   TEXT NOT NULL,
  role_id     TEXT REFERENCES roles(id) ON DELETE SET NULL,
  max_uses    INTEGER NOT NULL DEFAULT 1 CHECK (max_uses >= 1),
  used_count  INTEGER NOT NULL DEFAULT 0,
  expires_at  TEXT,
  revoked_at  TEXT,
  created_by  TEXT NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0004_registration_keys.sql');
