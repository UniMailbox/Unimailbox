-- migrations/0014_better_auth_substrate.verify.sql — CAP-042 verification.
-- Every SELECT emits the runner's required { assertion, pass } shape.

SELECT '0014_users_email_verified_column' AS assertion,
       COUNT(*) = 1 AS pass
FROM pragma_table_info('users')
WHERE name = 'email_verified' AND type = 'INTEGER' AND [notnull] = 1 AND dflt_value = '0';

SELECT '0014_users_image_column' AS assertion,
       COUNT(*) = 1 AS pass
FROM pragma_table_info('users')
WHERE name = 'image' AND type = 'TEXT';

SELECT '0014_auth_tables_exist' AS assertion,
       COUNT(*) = 3 AS pass
FROM sqlite_master
WHERE type = 'table'
  AND name IN ('auth_accounts', 'auth_sessions', 'auth_verifications');

SELECT '0014_auth_accounts_exact_columns' AS assertion,
       COUNT(*) = 14 AS pass
FROM pragma_table_info('auth_accounts')
WHERE name IN (
  'id', 'issuer', 'account_id', 'provider_id', 'user_id', 'access_token',
  'refresh_token', 'id_token', 'access_token_expires_at',
  'refresh_token_expires_at', 'scope', 'password', 'created_at', 'updated_at'
);

SELECT '0014_auth_sessions_exact_columns' AS assertion,
       COUNT(*) = 8 AS pass
FROM pragma_table_info('auth_sessions')
WHERE name IN (
  'id', 'token', 'user_id', 'expires_at', 'ip_address', 'user_agent',
  'created_at', 'updated_at'
);

SELECT '0014_auth_verifications_exact_columns' AS assertion,
       COUNT(*) = 6 AS pass
FROM pragma_table_info('auth_verifications')
WHERE name IN ('id', 'identifier', 'value', 'expires_at', 'created_at', 'updated_at');

SELECT '0014_auth_foreign_keys_cascade' AS assertion,
       (
         (SELECT COUNT(*) FROM pragma_foreign_key_list('auth_accounts')
          WHERE [table] = 'users' AND [from] = 'user_id' AND [to] = 'id' AND on_delete = 'CASCADE') = 1
         AND
         (SELECT COUNT(*) FROM pragma_foreign_key_list('auth_sessions')
          WHERE [table] = 'users' AND [from] = 'user_id' AND [to] = 'id' AND on_delete = 'CASCADE') = 1
       ) AS pass;

SELECT '0014_auth_indexes_exist' AS assertion,
       COUNT(*) = 4 AS pass
FROM sqlite_master
WHERE type = 'index'
  AND name IN (
    'auth_accounts_issuer_account_id_unique',
    'auth_accounts_user_id_idx',
    'auth_sessions_token_unique',
    'auth_sessions_user_id_idx'
  );

SELECT '0014_verification_identifier_index_exists' AS assertion,
       COUNT(*) = 1 AS pass
FROM sqlite_master
WHERE type = 'index' AND name = 'auth_verifications_identifier_idx';

SELECT '0014_triggers_exist' AS assertion,
       COUNT(*) = 5 AS pass
FROM sqlite_master
WHERE type = 'trigger'
  AND name IN (
    'cap042_users_name_fallback_insert',
    'cap042_users_name_fallback_update',
    'cap042_auth_sessions_cap_insert',
    'cap042_auth_accounts_password_revoke',
    'cap042_registration_keys_used_count_guard'
  );

-- BEGIN LOCAL BEHAVIOR CHECKS
-- Behavior smoke fixtures. Reserved verify IDs are removed before and after use.
DELETE FROM auth_verifications WHERE id = 'verify-cap042-verification';
DELETE FROM auth_sessions WHERE user_id IN ('verify-cap042-user-a', 'verify-cap042-user-b');
DELETE FROM auth_accounts WHERE user_id IN ('verify-cap042-user-a', 'verify-cap042-user-b');
DELETE FROM registration_keys WHERE id = 'verify-cap042-key';
DELETE FROM users WHERE id IN ('verify-cap042-user-a', 'verify-cap042-user-b');

INSERT INTO users (
  id, email, display_name, status, password_algorithm, password_iterations,
  password_salt, password_hash, created_at, updated_at
) VALUES (
  'verify-cap042-user-a', 'verify-name@example.test', NULL, 'active',
  'pbkdf2-sha256', 600000, x'00', x'11', '2026-01-01 00:00:00', '2026-01-01 00:00:00'
);

INSERT INTO users (
  id, email, display_name, status, password_algorithm, password_iterations,
  password_salt, password_hash, created_at, updated_at
) VALUES (
  'verify-cap042-user-b', 'verify-other@example.test', 'Verify Other', 'active',
  'pbkdf2-sha256', 600000, x'00', x'11', '2026-01-01 00:00:00', '2026-01-01 00:00:00'
);

SELECT '0014_display_name_insert_fallback_works' AS assertion,
       COUNT(*) = 1 AS pass
FROM users
WHERE id = 'verify-cap042-user-a' AND display_name = 'verify-name';

INSERT INTO auth_accounts (
  id, issuer, account_id, provider_id, user_id, password, created_at, updated_at
) VALUES (
  'verify-cap042-account-a', 'local:credential', 'verify-cap042-user-a',
  'credential', 'verify-cap042-user-a', 'before', 1767225600000, 1767225600000
);

INSERT INTO auth_sessions (
  id, token, user_id, expires_at, created_at, updated_at
) VALUES
  ('verify-cap042-session-01', 'verify-cap042-token-01', 'verify-cap042-user-a', 1769000000000, 1, 1),
  ('verify-cap042-session-02', 'verify-cap042-token-02', 'verify-cap042-user-a', 1769000000000, 2, 2),
  ('verify-cap042-session-03', 'verify-cap042-token-03', 'verify-cap042-user-a', 1769000000000, 3, 3),
  ('verify-cap042-session-04', 'verify-cap042-token-04', 'verify-cap042-user-a', 1769000000000, 4, 4),
  ('verify-cap042-session-05', 'verify-cap042-token-05', 'verify-cap042-user-a', 1769000000000, 5, 5),
  ('verify-cap042-session-06', 'verify-cap042-token-06', 'verify-cap042-user-a', 1769000000000, 6, 6),
  ('verify-cap042-session-07', 'verify-cap042-token-07', 'verify-cap042-user-a', 1769000000000, 7, 7),
  ('verify-cap042-session-08', 'verify-cap042-token-08', 'verify-cap042-user-a', 1769000000000, 8, 8),
  ('verify-cap042-session-09', 'verify-cap042-token-09', 'verify-cap042-user-a', 1769000000000, 9, 9),
  ('verify-cap042-session-10', 'verify-cap042-token-10', 'verify-cap042-user-a', 1769000000000, 10, 10),
  ('verify-cap042-session-11', 'verify-cap042-token-11', 'verify-cap042-user-a', 1769000000000, 11, 11);

SELECT '0014_session_cap_keeps_newest_ten' AS assertion,
       COUNT(*) = 10
       AND SUM(id = 'verify-cap042-session-01') = 0
       AND SUM(id = 'verify-cap042-session-11') = 1 AS pass
FROM auth_sessions
WHERE user_id = 'verify-cap042-user-a';

INSERT INTO auth_sessions (
  id, token, user_id, expires_at, created_at, updated_at
) VALUES (
  'verify-cap042-session-other', 'verify-cap042-token-other',
  'verify-cap042-user-b', 1769000000000, 1, 1
);

UPDATE auth_accounts SET password = 'after' WHERE id = 'verify-cap042-account-a';

SELECT '0014_password_change_revokes_target_sessions_only' AS assertion,
       (
         (SELECT COUNT(*) FROM auth_sessions WHERE user_id = 'verify-cap042-user-a') = 0
         AND
         (SELECT COUNT(*) FROM auth_sessions WHERE user_id = 'verify-cap042-user-b') = 1
       ) AS pass;

INSERT INTO auth_verifications (
  id, identifier, value, expires_at, created_at, updated_at
) VALUES (
  'verify-cap042-verification', 'verify@example.test', 'verify-value',
  1769000000000, 1767225600000, 1767225600000
);

SELECT '0014_verification_integer_dates_write' AS assertion,
       COUNT(*) = 1 AS pass
FROM auth_verifications
WHERE id = 'verify-cap042-verification'
  AND typeof(expires_at) = 'integer'
  AND typeof(created_at) = 'integer'
  AND typeof(updated_at) = 'integer';

SELECT '0014_tracking_row_exists' AS assertion,
       COUNT(*) = 1 AS pass
FROM d1_migrations
WHERE name = '0014_better_auth_substrate.sql';

DELETE FROM auth_verifications WHERE id = 'verify-cap042-verification';
DELETE FROM auth_sessions WHERE user_id IN ('verify-cap042-user-a', 'verify-cap042-user-b');
DELETE FROM auth_accounts WHERE user_id IN ('verify-cap042-user-a', 'verify-cap042-user-b');
DELETE FROM registration_keys WHERE id = 'verify-cap042-key';
DELETE FROM users WHERE id IN ('verify-cap042-user-a', 'verify-cap042-user-b');
