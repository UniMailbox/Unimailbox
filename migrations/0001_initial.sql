-- migrations/0001_initial.sql — Phase 0 schema.
-- The 11 tables every Phase 0 capability touches. Authoritative; reviewed
-- by hand per docs/rebuild/05-target-architecture/data-model.md §Migration
-- authority. Drizzle schemas in apps/worker/src/database/schema/* are typing
-- only and must not be used to generate this file.
--
-- Rules enforced in this file:
--   R-AUTH-002  users.status CHECK ('active'|'banned'|'deleted')
--   R-AUTH-003  sessions(user_id, expires_at) eviction index
--   R-AUTH-005  sessions.user_id ON DELETE CASCADE
--   R-AUTH-009  users.email COLLATE NOCASE
--   R-DATA-001  email columns everywhere COLLATE NOCASE
--   R-DATA-003  deleted_at TIMESTAMP NULL on users
--   R-DATA-004  PRAGMA foreign_keys = ON at connection open (D1's default;
--               verified by 0001_initial.verify.sql assertion #1)
--   R-DATA-005  no JSON-in-text columns — audit_events.metadata is the
--               explicit exception (documented in 0001_initial.md). The
--               metadata column is capped at 65536 bytes via CHECK so a
--               runaway audit writer cannot fill the DB.
--   ADR-006     users.password_{algorithm, iterations, salt, hash}; the
--               password_iterations floor is 100000 (deferred floor — see
--               0001_initial.md and D-CAP-004-A). The application layer
--               enforces the ADR's 600000 default.
--   ADR-007     encrypted_credentials.{ciphertext, iv, auth_tag, version}.
--               iv and auth_tag are pinned to GCM's 12- and 16-byte
--               canonical sizes via CHECK; a mismatched encryptor is
--               rejected at INSERT time.
--
-- Tracking convention (F1): every migration creates the d1_migrations
-- table (IF NOT EXISTS) and inserts its own row in the same file, so
-- a D1 batch that contains both the schema and the tracking row is
-- atomic — apply and track together. See 0001_initial.md §Companion
-- files for the convention future migrations must follow.
--
-- Idempotency: every CREATE in this file uses IF NOT EXISTS so the
-- migration is safely re-runnable. The apply is one D1 batch; if the
-- batch fails (e.g. a future migration adds a non-idempotent DDL
-- clause) the entire batch rolls back and the d1_migrations row is
-- not recorded. If the batch succeeds against a partially-applied
-- state (e.g. an operator dropped d1_migrations but left the schema
-- intact), the existing tables remain and the tracking row is
-- re-recorded.
--
-- ON DELETE policy (per data-model.md §Foreign-key rule + decisions table):
--   CASCADE for hard ownership (sessions → users, role_permissions → roles,
--     role_permissions → permissions, user_roles → user, user_roles → role).
--   SET NULL for soft references (audit_events.actor_user_id → users,
--     user_roles.granted_by → users) — keep history even when the user is
--     deleted.

-- ============================================================
-- Onboarding: installation_state (single-row table, Phase 0 stub)
-- ============================================================
CREATE TABLE IF NOT EXISTS installation_state (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  status          TEXT    NOT NULL CHECK (status IN ('setup', 'complete')),
  current_step    TEXT    NOT NULL CHECK (current_step IN (
                    'claim','preflight','administrator','domain',
                    'cloudflare-verify','inbound-smoke','brevo',
                    'outbound-smoke','complete')),
  schema_version  INTEGER NOT NULL,
  claimed_by      TEXT,
  updated_at      TEXT    NOT NULL,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- Admin: system_settings (key/value configuration)
-- ============================================================
CREATE TABLE IF NOT EXISTS system_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- Identity: users (R-AUTH-002, R-AUTH-009, ADR-006)
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  id                    TEXT    PRIMARY KEY,
  email                 TEXT    NOT NULL COLLATE NOCASE,
  display_name          TEXT    CHECK (display_name IS NULL OR length(display_name) <= 100),
  status                TEXT    NOT NULL CHECK (status IN ('active','banned','deleted')),
  password_algorithm    TEXT    NOT NULL,
  password_iterations   INTEGER NOT NULL CHECK (password_iterations >= 100000),
  password_salt         BLOB    NOT NULL,
  password_hash         BLOB    NOT NULL,
  created_at            TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT    NOT NULL DEFAULT (datetime('now')),
  deleted_at            TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users(email COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS users_status_idx ON users(status);

-- ============================================================
-- Identity: sessions (R-AUTH-003 eviction query, R-AUTH-005 cascade)
-- ============================================================
CREATE TABLE IF NOT EXISTS sessions (
  id                  TEXT    PRIMARY KEY,
  user_id             TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash  TEXT    NOT NULL,
  expires_at          INTEGER NOT NULL,
  ip                  TEXT    CHECK (ip IS NULL OR length(ip) <= 45),
  user_agent          TEXT    CHECK (user_agent IS NULL OR length(user_agent) <= 512),
  created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
  revoked_at          TEXT
);

CREATE INDEX IF NOT EXISTS sessions_user_id_expires_at_idx ON sessions(user_id, expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS sessions_refresh_token_hash_unique ON sessions(refresh_token_hash);

-- ============================================================
-- Outbound Mail: encrypted_credentials (ADR-007 AES-GCM)
-- ============================================================
CREATE TABLE IF NOT EXISTS encrypted_credentials (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL COLLATE NOCASE,
  version     INTEGER NOT NULL DEFAULT 1,
  ciphertext  BLOB NOT NULL,
  iv          BLOB NOT NULL CHECK (length(iv) = 12),
  auth_tag    BLOB NOT NULL CHECK (length(auth_tag) = 16),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS encrypted_credentials_name_unique ON encrypted_credentials(name COLLATE NOCASE);

-- ============================================================
-- Admin: permissions (closed enum of keys; R-AUTHZ-001)
-- ============================================================
CREATE TABLE IF NOT EXISTS permissions (
  id          TEXT PRIMARY KEY,
  key         TEXT NOT NULL,
  description TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS permissions_key_unique ON permissions(key);

-- ============================================================
-- Admin: roles (administrator, member, etc.)
-- ============================================================
CREATE TABLE IF NOT EXISTS roles (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL COLLATE NOCASE,
  description TEXT NOT NULL,
  is_system   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS roles_name_unique ON roles(name COLLATE NOCASE);

-- ============================================================
-- Admin: role_permissions (composite pk)
-- ============================================================
CREATE TABLE IF NOT EXISTS role_permissions (
  role_id        TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id  TEXT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (role_id, permission_id)
);

-- ============================================================
-- Admin: user_roles (R-AUTHZ-005 admin lives here, not on user)
-- ============================================================
CREATE TABLE IF NOT EXISTS user_roles (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id     TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  granted_at  TEXT NOT NULL DEFAULT (datetime('now')),
  granted_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (user_id, role_id)
);

CREATE INDEX IF NOT EXISTS user_roles_role_id_idx ON user_roles(role_id);

-- ============================================================
-- Admin: audit_events (R-AUDIT-001..004)
-- metadata is text(JSON) — explicit R-DATA-005 exception, see 0001_initial.md.
-- ============================================================
CREATE TABLE IF NOT EXISTS audit_events (
  id             TEXT PRIMARY KEY,
  actor_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  action         TEXT NOT NULL CHECK (length(action) <= 64),
  resource_type  TEXT NOT NULL CHECK (length(resource_type) <= 64),
  resource_id    TEXT CHECK (resource_id IS NULL OR length(resource_id) <= 128),
  request_id     TEXT CHECK (request_id IS NULL OR length(request_id) <= 64),
  metadata       TEXT CHECK (metadata IS NULL OR length(metadata) <= 65536),
  ip             TEXT CHECK (ip IS NULL OR length(ip) <= 45),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS audit_events_resource_idx ON audit_events(resource_type, resource_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_actor_idx    ON audit_events(actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_created_idx  ON audit_events(created_at DESC);

-- ============================================================
-- Admin: maintenance_jobs (R-WORKFLOW-005 idempotent + cursor)
-- ============================================================
CREATE TABLE IF NOT EXISTS maintenance_jobs (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('pending','running','done','failed')),
  cursor        TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT CHECK (last_error IS NULL OR length(last_error) <= 8192),
  scheduled_at  TEXT NOT NULL DEFAULT (datetime('now')),
  started_at    TEXT,
  completed_at  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS maintenance_jobs_status_scheduled_at_idx ON maintenance_jobs(status, scheduled_at);

-- ============================================================
-- Migration tracking (F1) — apply+track are atomic.
-- The schema and the tracking row ship in the same D1 batch, so a
-- crash mid-batch rolls back both. Future migrations (0002_*.sql …)
-- must follow the same convention: CREATE TABLE IF NOT EXISTS
-- d1_migrations (...) then INSERT OR IGNORE INTO d1_migrations
-- (name) VALUES ('<this-file>.sql'). See 0001_initial.md §Companion
-- files.
-- ============================================================
CREATE TABLE IF NOT EXISTS d1_migrations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE CHECK (length(name) <= 256),
  applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0001_initial.sql');