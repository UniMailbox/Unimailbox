-- migrations/0014_better_auth_substrate.sql — CAP-042 / ADR-008 Better Auth
-- additive substrate.
--
-- This is the additive schema for the Better Auth boundary. It does NOT
-- rebuild the canonical `users` table, does NOT reject legacy writers, and
-- does NOT change the canonical user ID column. Drizzle typing catches up
-- in apps/worker/src/database/schema/identity.ts; this file is the
-- deployable artifact (per ADR-008 §Database ownership and
-- docs/rebuild/05-target-architecture/data-model.md §Migration authority).
--
-- Rules enforced here:
--   R-AUTH-001  email_verified is a 0/1 column with default 0 so the
--               canonical users table satisfies Better Auth's mapping
--               without losing R-DATA-005 case-insensitive behavior.
--   R-AUTH-002  status enum is preserved (active/banned/deleted); legacy
--               writers continue to write with the existing displayName
--               constraint unchanged.
--   R-AUTH-003  An AFTER INSERT trigger on auth_sessions keeps at most 10
--               sessions per user (created_at DESC, id DESC).
--   R-AUTH-005  An AFTER UPDATE OF password trigger on auth_accounts
--               revokes every auth_session for that user.
--   R-AUTH-009  email stays NOCASE; this migration does not modify the
--               column collation.
--   R-DATA-004  PRAGMA foreign_keys = ON remains enforced at the runtime
--               boundary; every new FK is declared ON DELETE CASCADE.
--   R-DATA-005  All new columns are typed (no JSON-in-text).
--
-- Migration tracking (F1): the INSERT OR IGNORE INTO d1_migrations makes
-- apply+track atomic with the schema change.

-- ============================================================================
-- 1. ALTER users — additive Better Auth compatibility columns.
-- ============================================================================

-- R-AUTH-001: verified-email policy. Better Auth 1.7.1 requires the boolean
-- emailVerified; we back it with INTEGER NOT NULL DEFAULT 0 to keep the
-- canonical users shape relational (no JSON-in-text). The CHECK enforces
-- the boolean domain at the SQL boundary.
ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0
  CHECK (email_verified IN (0, 1));

-- Better Auth 1.7.1 model.user has an optional `image` column. Nullable
-- TEXT — the application does not upload avatars in v1 (out of scope for
-- CAP-042 per task.md), but the schema column is reserved so the logical
-- model mapping does not need a follow-up migration later.
ALTER TABLE users ADD COLUMN image TEXT;

-- ============================================================================
-- 2. Backfill existing NULL/empty display_name with a deterministic fallback.
-- ============================================================================
--
-- Rule: when display_name is NULL or trim-empty, use the email prefix
-- (substring before '@') capped to 100 characters. When the email has no
-- usable prefix (e.g. starts with '@'), fall back to the first 100 chars of
-- the full email. This makes the column NOT-NULL in practice for every row
-- the application ever reads while leaving the column nullable in the DDL so
-- legacy writers (which may still produce NULL before a follow-up update)
-- continue to succeed.
--
-- The check on display_name (length <= 100) is preserved; the fallback is
-- always <= 100 chars.

UPDATE users
SET display_name = substr(
  CASE
    WHEN instr(email, '@') > 1 THEN substr(email, 1, instr(email, '@') - 1)
    ELSE email
  END,
  1, 100
)
WHERE display_name IS NULL OR trim(display_name) = '';

-- ============================================================================
-- 3. Display-name fallback triggers — applied to any future writer that
--    leaves display_name NULL or trim-empty.
-- ============================================================================
--
-- We do not tighten the column constraint, so any legacy or out-of-band
-- writer (e.g. an ops SQL migration that inserts a user without a name)
-- still succeeds. The triggers then patch the row to the same deterministic
-- fallback so the application layer can rely on a non-empty display_name at
-- read time. The original Better Auth `name` mapping stays viable without a
-- NOT NULL constraint violating legacy writers.

CREATE TRIGGER cap042_users_name_fallback_insert
AFTER INSERT ON users
WHEN NEW.display_name IS NULL OR trim(NEW.display_name) = ''
BEGIN
  UPDATE users
  SET display_name = substr(
    CASE
      WHEN instr(NEW.email, '@') > 1 THEN substr(NEW.email, 1, instr(NEW.email, '@') - 1)
      ELSE NEW.email
    END,
    1, 100
  )
  WHERE id = NEW.id;
END;

CREATE TRIGGER cap042_users_name_fallback_update
AFTER UPDATE OF display_name, email ON users
WHEN NEW.display_name IS NULL OR trim(NEW.display_name) = ''
BEGIN
  UPDATE users
  SET display_name = substr(
    CASE
      WHEN instr(NEW.email, '@') > 1 THEN substr(NEW.email, 1, instr(NEW.email, '@') - 1)
      ELSE NEW.email
    END,
    1, 100
  )
  WHERE id = NEW.id;
END;

-- ============================================================================
-- 4. auth_accounts — Better Auth 1.7.1 `account` model on D1.
-- ============================================================================
--
-- Spike fields verified against the generated SQLite shape and pinned in
-- docs/rebuild/09-decisions/ADR-008-better-auth-on-cloudflare-d1.md and
-- work/active/CAP-042-better-auth-shell/spike-evidence.md §Generated SQLite
-- schema comparison. The compound UNIQUE on (issuer, account_id) is the
-- canonical OAuth account locator. user_id is indexed for the session
-- bridge and password-revoke trigger below.

CREATE TABLE IF NOT EXISTS auth_accounts (
  id                       TEXT    PRIMARY KEY NOT NULL,
  issuer                   TEXT    NOT NULL,
  account_id               TEXT    NOT NULL,
  provider_id              TEXT    NOT NULL,
  user_id                  TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  access_token             TEXT,
  refresh_token            TEXT,
  id_token                 TEXT,
  access_token_expires_at  INTEGER,
  refresh_token_expires_at INTEGER,
  scope                    TEXT,
  password                 TEXT,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS auth_accounts_issuer_account_id_unique
  ON auth_accounts(issuer, account_id);

CREATE INDEX IF NOT EXISTS auth_accounts_user_id_idx
  ON auth_accounts(user_id);

-- ============================================================================
-- 5. auth_sessions — Better Auth 1.7.1 `session` model on D1.
-- ============================================================================
--
-- `token` is the opaque session secret hashed into the cookie. UNIQUE on
-- token is the lookup key for Better Auth's getSession. user_id FK with
-- ON DELETE CASCADE matches the Better Auth logical model. All timestamps
-- are Unix epoch milliseconds per the generated SQLite shape.

CREATE TABLE IF NOT EXISTS auth_sessions (
  id           TEXT    PRIMARY KEY NOT NULL,
  token        TEXT    NOT NULL,
  user_id      TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at   INTEGER NOT NULL,
  ip_address   TEXT,
  user_agent   TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS auth_sessions_token_unique
  ON auth_sessions(token);

CREATE INDEX IF NOT EXISTS auth_sessions_user_id_idx
  ON auth_sessions(user_id);

-- ============================================================================
-- 6. auth_verifications — Better Auth 1.7.1 `verification` model on D1.
-- ============================================================================
--
-- Stores email-verification and password-reset tokens. identifier is
-- indexed (Better Auth lookup is by identifier). expires_at drives the
-- expiry sweep.

CREATE TABLE IF NOT EXISTS auth_verifications (
  id          TEXT    PRIMARY KEY NOT NULL,
  identifier  TEXT    NOT NULL,
  value       TEXT    NOT NULL,
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS auth_verifications_identifier_idx
  ON auth_verifications(identifier);

-- ============================================================================
-- 7. R-AUTH-003 auth_sessions cap trigger.
-- ============================================================================
--
-- After every INSERT on auth_sessions, if the user has more than ten rows
-- we keep the ten newest (created_at DESC, id DESC) and delete the rest.
-- This is deterministic and applies even when many sessions are inserted in
-- the same batch — each INSERT fires its own trigger, so the post-insert
-- row count is back down to <= 10 before the next statement runs.

CREATE TRIGGER cap042_auth_sessions_cap_insert
AFTER INSERT ON auth_sessions
WHEN (SELECT COUNT(*) FROM auth_sessions WHERE user_id = NEW.user_id) > 10
BEGIN
  DELETE FROM auth_sessions
  WHERE id IN (
    SELECT id
    FROM auth_sessions
    WHERE user_id = NEW.user_id
    ORDER BY created_at DESC, id DESC
    LIMIT -1 OFFSET 10
  );
END;

-- ============================================================================
-- 8. R-AUTH-005 password-change revoke trigger.
-- ============================================================================
--
-- When the credential row's password column changes, every auth_session for
-- the same user must be revoked (R-AUTH-005). The trigger deletes every
-- row in auth_sessions whose user_id matches the credential's user_id; we
-- use the literal-preserving NULL-safe inequality `OLD.password IS NOT
-- NEW.password` so no spurious revokes fire when both values are NULL.

CREATE TRIGGER cap042_auth_accounts_password_revoke
AFTER UPDATE OF password ON auth_accounts
WHEN OLD.password IS NOT NEW.password
BEGIN
  DELETE FROM auth_sessions WHERE user_id = NEW.user_id;
END;

-- ============================================================================
-- 9. Registration-key usage guard trigger.
-- ============================================================================
--
-- The application batches a registration write with an increment of
-- registration_keys.used_count. A zero-row UPDATE would not fail a D1 batch
-- (silently committing the other statements), so the trigger converts an
-- over-limit increment into an in-batch SQLite ABORT, rolling back the
-- entire batch. The condition is `NEW.used_count > OLD.max_uses` (strict)
-- so an explicit used_count = max_uses remains a successful final write.

CREATE TRIGGER cap042_registration_keys_used_count_guard
BEFORE UPDATE OF used_count ON registration_keys
WHEN NEW.used_count > OLD.max_uses
BEGIN
  SELECT RAISE(ABORT, 'CAP042_REGISTRATION_KEY_EXHAUSTED');
END;

-- ============================================================================
-- 10. Migration tracking — atomic with the schema change (F1).
-- ============================================================================
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0014_better_auth_substrate.sql');
