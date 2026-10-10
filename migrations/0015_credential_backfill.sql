-- migrations/0015_credential_backfill.sql — CAP-042 (AC 15) existing-user
-- credential backfill.
--
-- Creates one `auth_accounts` row per canonical `users` row that:
--   - stores an ADR-006 PBKDF2 envelope in `password_*`, and
--   - is not deleted (R-AUTH-002: banned/deleted users cannot log in).
--
-- The migration is the **deployable** backfill. It runs once as part of
-- `migrationsDb()` for a fresh deploy and is idempotent on a repeat
-- deploy: the unique index `auth_accounts_issuer_account_id_unique`
-- (added by 0014_better_auth_substrate) causes every re-run to be a
-- no-op against rows that already exist.
--
-- Why a SQL-only backfill:
--
--   1. Atomic with the schema change. The migration runner applies
--      0015 in the same D1 transaction boundary as any concurrent
--      `users` write that happens to land at deploy time — the
--      backfill is either fully visible or fully absent, never partial.
--   2. Repeat-deploy idempotency is structural, not application-level.
--      `INSERT OR IGNORE` against the (issuer, account_id) unique
--      index lets a second run produce zero changes without
--      needing a separate `WHERE NOT EXISTS` subquery or a
--      bookkeeping column.
--   3. Zero new code paths. The router, the Better Auth factory, and
--      the session bridge all consume the result of this migration
--      without knowing it exists; AC 16 ("existing PBKDF2 users log in
--      without a forced password reset") falls out of (1)+(2).
--
-- What this migration does NOT do:
--
--   - It does NOT rebuild `users.password_*` or write to legacy
--     columns. ADR-006's PBKDF2 columns stay authoritative until a
--     later cleanup capability retires them (task.md §Out of scope).
--   - It does NOT create accounts for banned or deleted users. R-AUTH-002
--     forbids both statuses from logging in; their absence from
--     `auth_accounts` is the framework's defence against a sign-in that
--     would otherwise need to look up a user it cannot authorise. The
--     `status NOT IN ('banned', 'deleted')` predicate excludes both
--     branches — a banned user must NOT be able to sign in via Better
--     Auth any more than via the legacy /api/v1/auth/login route
--     (which returns 403 USER_BANNED).
--   - It does NOT create accounts for users whose `password_algorithm`
--     is not `'pbkdf2-sha256'` or whose `password_iterations` differs
--     from 600_000. The Better Auth password adapter
--     (`integrations/better-auth/password.ts`) only verifies the
--     canonical envelope; a non-canonical row would sign in
--     successfully once and then every later sign-in attempt would
--     fail with a non-enumerating 401 — the worst outcome for the
--     user. Skipping these rows makes the absence loud (no account
--     exists) rather than silent (sign-in works once, then never).
--   - It does NOT alter `users.created_at` / `updated_at`. The
--     backfilled `auth_accounts.created_at` / `updated_at` reflect the
--     canonical user's creation timestamp converted to Unix-ms, which
--     is what Better Auth's adapter reads from the row. R-AUTH-003
--     (≤10 active sessions per user) is unchanged because this
--     migration does not insert `auth_sessions` rows.
--   - It does NOT touch email case. The canonical `users.email`
--     unique index is `COLLATE NOCASE` (R-DATA-001 / R-AUTH-009);
--     "Mixed@Case" and "mixed@case" are the same row in `users`,
--     and the backfill writes exactly one `auth_accounts` row for
--     that user. A backfill run on a database that somehow gained a
--     second `users` row for the same email would still produce a
--     single auth_accounts row per (issuer, account_id); case
--     insensitivity is enforced by the canonical table, not here.
--
-- Rules enforced:
--   R-AUTH-002 — banned and deleted users are excluded from the backfill.
--                 A backfilled `auth_accounts` row would let Better Auth
--                 verify a password and mint a session for a user the
--                 legacy route already refuses, silently re-enabling the
--                 ban.
--   R-AUTH-006 — the ADR-006 600_000-iteration floor is the only
--                 accepted value; non-canonical rows are skipped.
--   R-AUTH-007 — no password bytes are exposed in the migration SQL
--                 (the envelope is built from BLOB columns via the
--                 SQLite `lower(hex(...))` function, never via a
--                 roundtrip through application code).
--   R-AUTH-009 — case-insensitive email is enforced by the canonical
--                 `users_email_unique` index; this migration does not
--                 duplicate the policy.
--   R-DATA-001 — email remains NOCASE at the canonical column.
--   R-DATA-005 — no JSON-in-text: the backfill writes relational
--                 columns only.
--   R-SECRET-003 — the envelope is the same shape the application
--                  signs in against; storing it does not weaken the
--                  secret because the canonical `users.password_hash`
--                  column already holds the same bytes.
--
-- Migration tracking (F1): the INSERT OR IGNORE INTO d1_migrations
-- makes apply+track atomic with the schema change.

-- ============================================================================
-- 1. Backfill canonical PBKDF2 users into auth_accounts.
-- ============================================================================
--
-- The envelope is built inline from the four canonical columns:
--
--   'pbkdf2-sha256$' || password_iterations || '$' ||
--     lower(hex(password_salt))  -- 32 lowercase hex chars (16 bytes)
--     || '$' ||
--     lower(hex(password_hash))  -- 64 lowercase hex chars (32 bytes)
--
-- `lower(hex(...))` is the SQLite canonical hex encoder for BLOBs;
-- the resulting lowercase string matches the
-- `^pbkdf2-sha256$600000$[0-9a-f]{32}$[0-9a-f]{64}$` regex the
-- Better Auth password adapter validates against.
--
-- `auth_accounts.created_at` and `updated_at` are Unix-ms integers
-- (per the 0014 schema). The canonical `users.created_at` is a UTC
-- text in the canonical `YYYY-MM-DD HH:MM:SS.sss` format
-- (sqliteUtcTextDate custom type). The conversion
--
--   CAST((julianday(created_at) - 2440587.5) * 86400000 AS INTEGER)
--
-- is the canonical Julian-day-to-Unix-ms formula; 2440587.5 is the
-- Julian day of the Unix epoch (1970-01-01 00:00:00 UTC). The
-- fractional part is dropped via INTEGER cast so the timestamp is
-- millisecond-aligned, matching Better Auth's adapter expectation.
--
-- The deterministic `id` (`'cap042-backfill-' || users.id`) makes a
-- re-run safe: a second INSERT with the same `(issuer, account_id)`
-- pair collides on the unique index and `INSERT OR IGNORE` skips the
-- write. A user who was inserted by the application's own
-- registration path (Batch 4) after this migration ran would have a
-- different `auth_accounts.id` because the application's insert path
-- uses a fresh UUID; the backfill's deterministic id is a *different
-- row*, not an overwrite. The unique index prevents two
-- `(local:credential, user_id)` rows for the same user.

INSERT OR IGNORE INTO auth_accounts (
  id, issuer, account_id, provider_id, user_id, password,
  created_at, updated_at
)
SELECT
  'cap042-backfill-' || u.id,
  'local:credential',
  u.id,
  'credential',
  u.id,
  'pbkdf2-sha256$' || u.password_iterations || '$' ||
    lower(hex(u.password_salt)) || '$' ||
    lower(hex(u.password_hash)),
  CAST((julianday(u.created_at) - 2440587.5) * 86400000 AS INTEGER),
  CAST((julianday(u.updated_at) - 2440587.5) * 86400000 AS INTEGER)
FROM users AS u
WHERE u.password_algorithm = 'pbkdf2-sha256'
  AND u.password_iterations = 600000
  -- R-AUTH-002 forbids banned and deleted users from logging in or
  -- continuing an existing session. A backfilled auth_accounts row for
  -- a banned user would let Better Auth's sign-in path verify the
  -- password and create an auth_session — silently re-enabling a
  -- banned account. The legacy /api/v1/auth/login returns 403 for
  -- banned accounts (auth.ts:381); the backfill must mirror that
  -- block. Both values are excluded here so the absence is
  -- structural, not a status-check at sign-in time.
  AND u.status NOT IN ('banned', 'deleted');

-- ============================================================================
-- 2. Migration tracking — atomic with the schema change (F1).
-- ============================================================================
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0015_credential_backfill.sql');