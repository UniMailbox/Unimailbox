-- Verification for 0015_credential_backfill.sql.

SELECT '0015_tracking_row_exists' AS assertion,
  COUNT(*) = 1 AS pass
FROM d1_migrations WHERE name = '0015_credential_backfill.sql';

SELECT '0015_eligible_source_target_count_matches' AS assertion,
  (SELECT COUNT(*) FROM users
    WHERE password_algorithm = 'pbkdf2-sha256'
      AND password_iterations = 600000
      AND status NOT IN ('banned', 'deleted'))
  =
  (SELECT COUNT(*) FROM auth_accounts
    WHERE issuer = 'local:credential'
      AND provider_id = 'credential'
      AND id LIKE 'cap042-backfill-%') AS pass;

SELECT '0015_banned_users_not_backfilled' AS assertion,
  COUNT(*) = 0 AS pass
FROM auth_accounts AS a
JOIN users AS u ON u.id = a.user_id
WHERE u.status = 'banned' AND a.provider_id = 'credential' AND a.id LIKE 'cap042-backfill-%';

SELECT '0015_deleted_users_not_backfilled' AS assertion,
  COUNT(*) = 0 AS pass
FROM auth_accounts AS a
JOIN users AS u ON u.id = a.user_id
WHERE u.status = 'deleted' AND a.provider_id = 'credential' AND a.id LIKE 'cap042-backfill-%';

SELECT '0015_non_pbkdf2_users_not_backfilled' AS assertion,
  COUNT(*) = 0 AS pass
FROM auth_accounts AS a
JOIN users AS u ON u.id = a.user_id
WHERE u.password_algorithm <> 'pbkdf2-sha256'
  AND a.provider_id = 'credential' AND a.id LIKE 'cap042-backfill-%';

SELECT '0015_noncanonical_iterations_not_backfilled' AS assertion,
  COUNT(*) = 0 AS pass
FROM auth_accounts AS a
JOIN users AS u ON u.id = a.user_id
WHERE u.password_iterations <> 600000
  AND a.provider_id = 'credential' AND a.id LIKE 'cap042-backfill-%';

SELECT '0015_no_duplicate_issuer_account_pairs' AS assertion,
  COUNT(*) = 0 AS pass
FROM (
  SELECT issuer, account_id FROM auth_accounts
  GROUP BY issuer, account_id HAVING COUNT(*) > 1
);

SELECT '0015_no_orphan_accounts' AS assertion,
  COUNT(*) = 0 AS pass
FROM auth_accounts AS a
LEFT JOIN users AS u ON u.id = a.user_id
WHERE u.id IS NULL;

SELECT '0015_password_prefix_valid' AS assertion,
  COUNT(*) = 0 AS pass
FROM auth_accounts
WHERE provider_id = 'credential' AND id LIKE 'cap042-backfill-%'
  AND password NOT LIKE 'pbkdf2-sha256$600000$%';

SELECT '0015_password_length_valid' AS assertion,
  COUNT(*) = 0 AS pass
FROM auth_accounts
WHERE provider_id = 'credential' AND id LIKE 'cap042-backfill-%'
  AND length(password) <> 118;

SELECT '0015_salt_hex_valid' AS assertion,
  COUNT(*) = 0 AS pass
FROM auth_accounts
WHERE provider_id = 'credential' AND id LIKE 'cap042-backfill-%'
  AND substr(password, 22, 32) GLOB '*[^0-9a-f]*';

SELECT '0015_hash_hex_valid' AS assertion,
  COUNT(*) = 0 AS pass
FROM auth_accounts
WHERE provider_id = 'credential' AND id LIKE 'cap042-backfill-%'
  AND substr(password, 55, 64) GLOB '*[^0-9a-f]*';

SELECT '0015_segment_separator_valid' AS assertion,
  COUNT(*) = 0 AS pass
FROM auth_accounts
WHERE provider_id = 'credential' AND id LIKE 'cap042-backfill-%'
  AND substr(password, 54, 1) <> '$';

SELECT '0015_no_trailing_characters' AS assertion,
  COUNT(*) = 0 AS pass
FROM auth_accounts
WHERE provider_id = 'credential' AND id LIKE 'cap042-backfill-%'
  AND substr(password, 119, 1) <> '';
