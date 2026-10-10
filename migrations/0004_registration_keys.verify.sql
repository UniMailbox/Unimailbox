-- Verification for 0004_registration_keys.sql.

SELECT '0004_table_exists' AS assertion,
  EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'registration_keys') AS pass;

SELECT '0004_required_columns_exist' AS assertion,
  COUNT(*) = 9 AS pass
FROM pragma_table_info('registration_keys')
WHERE name IN ('id', 'code_hash', 'role_id', 'max_uses', 'used_count', 'expires_at', 'revoked_at', 'created_by', 'created_at');

SELECT '0004_max_uses_check_exists' AS assertion,
  EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'registration_keys'
      AND instr(sql, 'CHECK (max_uses >= 1)') > 0
  ) AS pass;

SELECT '0004_foreign_keys_exist' AS assertion,
  COUNT(*) = 2 AS pass
FROM pragma_foreign_key_list('registration_keys')
WHERE ("from" = 'role_id' AND "table" = 'roles' AND on_delete = 'SET NULL')
   OR ("from" = 'created_by' AND "table" = 'users' AND on_delete = 'SET NULL');

SELECT '0004_tracking_row_exists' AS assertion,
  COUNT(*) = 1 AS pass
FROM d1_migrations WHERE name = '0004_registration_keys.sql';
