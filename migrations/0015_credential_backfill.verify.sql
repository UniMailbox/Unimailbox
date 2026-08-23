-- migrations/0015_credential_backfill.verify.sql — Verification queries for
-- 0015_credential_backfill.sql.
--
-- Verification checks (AC 15 acceptance matrix):
--   1. Migration tracking row exists.
--   2. Every canonical user with ADR-006 credentials and `status != 'deleted'`
--      produced exactly one `auth_accounts` row.
--   3. Banned users did NOT produce `auth_accounts` rows
--      (R-AUTH-002 — banned users cannot log in).
--   4. Deleted users did NOT produce `auth_accounts` rows
--      (R-AUTH-002 — deleted users cannot log in).
--   5. Non-PBKDF2 (`password_algorithm != 'pbkdf2-sha256'`) users did NOT
--      produce `auth_accounts` rows (canonical envelope only — future
--      OAuth-only accounts must not gain a `credential` row).
--   6. Non-canonical iterations (`password_iterations != 600000`) did NOT
--      produce `auth_accounts` rows (defence against legacy drift;
--      a non-ADR-006 envelope would sign in once then fail forever).
--   7. No duplicate `(issuer, account_id)` pairs in `auth_accounts` —
--      the unique index (added by 0014) is the structural guarantee.
--   8. No orphan `auth_accounts` rows — every backfilled row's `user_id`
--      references an existing `users.id` (FK ON DELETE CASCADE on the
--      canonical `auth_accounts.user_id` enforces this; the assertion
--      confirms the cascade did not leave a dangling row behind).
--   9. The envelope written to `auth_accounts.password` matches the
--      canonical envelope regex Better Auth validates against
--      (`^pbkdf2-sha256$600000$[0-9a-f]{32}$[0-9a-f]{64}$`).

-- ----------------------------------------------------------------------------
-- 1. Migration tracking row exists.
-- ----------------------------------------------------------------------------
SELECT COUNT(*) = 1 FROM d1_migrations WHERE name = '0015_credential_backfill.sql';

-- ----------------------------------------------------------------------------
-- 2. Every active PBKDF2 user produced exactly one backfill row.
-- ----------------------------------------------------------------------------
-- The source set is `users` rows with ADR-006 credentials that are not
-- deleted (the same predicate the migration uses). The target set is
-- the backfill rows the migration wrote — identified by the
-- deterministic `'cap042-backfill-'` id prefix.
SELECT
  (SELECT COUNT(*) FROM users
     WHERE password_algorithm = 'pbkdf2-sha256'
       AND password_iterations = 600000
       AND status <> 'deleted')
  =
  (SELECT COUNT(*) FROM auth_accounts
     WHERE issuer = 'local:credential'
       AND provider_id = 'credential'
       AND id LIKE 'cap042-backfill-%');

-- ----------------------------------------------------------------------------
-- 3. Banned users did NOT produce auth_accounts rows (R-AUTH-002).
-- ----------------------------------------------------------------------------
SELECT COUNT(*) = 0 FROM auth_accounts AS a
  JOIN users AS u ON u.id = a.user_id
  WHERE u.status = 'banned' AND a.provider_id = 'credential';

-- ----------------------------------------------------------------------------
-- 4. Deleted users did NOT produce auth_accounts rows (R-AUTH-002).
-- ----------------------------------------------------------------------------
SELECT COUNT(*) = 0 FROM auth_accounts AS a
  JOIN users AS u ON u.id = a.user_id
  WHERE u.status = 'deleted' AND a.provider_id = 'credential';

-- ----------------------------------------------------------------------------
-- 5. Non-PBKDF2 users did NOT produce auth_accounts rows.
-- ----------------------------------------------------------------------------
-- The source set must include at least one non-PBKDF2 user for the
-- assertion to be meaningful; the test harness plants such a row
-- before the migration runs. If the assertion fires against an
-- empty source set it would trivially pass without proving anything.
SELECT COUNT(*) = 0 FROM auth_accounts AS a
  JOIN users AS u ON u.id = a.user_id
  WHERE u.password_algorithm <> 'pbkdf2-sha256'
    AND a.provider_id = 'credential';

-- ----------------------------------------------------------------------------
-- 6. Non-canonical iterations did NOT produce auth_accounts rows.
-- ----------------------------------------------------------------------------
SELECT COUNT(*) = 0 FROM auth_accounts AS a
  JOIN users AS u ON u.id = a.user_id
  WHERE u.password_iterations <> 600000
    AND a.provider_id = 'credential';

-- ----------------------------------------------------------------------------
-- 7. No duplicate (issuer, account_id) pairs.
-- ----------------------------------------------------------------------------
SELECT COUNT(*) = 0 FROM (
  SELECT issuer, account_id, COUNT(*) AS n
  FROM auth_accounts
  GROUP BY issuer, account_id
  HAVING n > 1
);

-- ----------------------------------------------------------------------------
-- 8. No orphan auth_accounts rows — every user_id references a users row.
-- ----------------------------------------------------------------------------
SELECT COUNT(*) = 0 FROM auth_accounts AS a
  LEFT JOIN users AS u ON u.id = a.user_id
  WHERE u.id IS NULL;

-- ----------------------------------------------------------------------------
-- 9. The envelope shape matches Better Auth's canonical regex.
-- ----------------------------------------------------------------------------
-- D1 SQLite does not implement a `REGEXP` function (it is a MySQL
-- extension), so the regex assertion is decomposed into the
-- structural pieces Better Auth's password adapter enforces:
--
--   - Prefix must be the algorithm + iteration segment: `pbkdf2-sha256$600000$`.
--   - Total length must be exactly 118 characters
--     (13 + 7 + 1 + 32 salt hex + 1 + 64 hash hex).
--   - The salt segment must be exactly 32 lowercase hex characters;
--     a non-hex character would fail `CAST(... AS INTEGER)` in the
--     canonical re-derive path.
--   - The hash segment must be exactly 64 lowercase hex characters.
--
-- Better Auth's own verifier (`integrations/better-auth/password.ts`)
-- uses the `^pbkdf2-sha256$600000$[0-9a-f]{32}$[0-9a-f]{64}$` regex;
-- the prefix + length + per-segment hex checks below cover every
-- divergence that regex would catch except whitespace and the PHC
-- leading-dollar (the migration's encoder never produces either).

-- Prefix matches the canonical algorithm + iteration segment.
SELECT COUNT(*) = 0 FROM auth_accounts
  WHERE provider_id = 'credential'
    AND id LIKE 'cap042-backfill-%'
    AND password NOT LIKE 'pbkdf2-sha256$600000$%';

-- Total length is 118 characters
-- (`pbkdf2-sha256`=13 + `$600000`=7 + `$`=1 + salt=32 + `$`=1 + hash=64).
SELECT COUNT(*) = 0 FROM auth_accounts
  WHERE provider_id = 'credential'
    AND id LIKE 'cap042-backfill-%'
    AND length(password) <> 118;

-- Salt segment (chars 22..53) is exactly 32 lowercase hex chars.
-- The envelope layout is fixed: 13 algo + 1 $ + 7 iter + 1 $ + 32 salt
-- + 1 $ + 64 hash = 118. Position 22 is the first salt byte.
SELECT COUNT(*) = 0 FROM auth_accounts
  WHERE provider_id = 'credential'
    AND id LIKE 'cap042-backfill-%'
    AND substr(password, 22, 32) GLOB '*[^0-9a-f]*';

-- Hash segment (chars 55..118) is exactly 64 lowercase hex chars.
SELECT COUNT(*) = 0 FROM auth_accounts
  WHERE provider_id = 'credential'
    AND id LIKE 'cap042-backfill-%'
    AND substr(password, 55, 64) GLOB '*[^0-9a-f]*';

-- Salt/hash segments are separated by exactly one `$` (position 54).
SELECT COUNT(*) = 0 FROM auth_accounts
  WHERE provider_id = 'credential'
    AND id LIKE 'cap042-backfill-%'
    AND substr(password, 54, 1) <> '$';

-- No trailing characters after the canonical 118-char envelope.
SELECT COUNT(*) = 0 FROM auth_accounts
  WHERE provider_id = 'credential'
    AND id LIKE 'cap042-backfill-%'
    AND substr(password, 118, 1) <> '';