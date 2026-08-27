-- Verification for 0003_provider_connections.sql.
-- Every statement returns exactly one `{ assertion, pass }` row.

SELECT '0003_table_exists' AS assertion,
  EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'provider_connections') AS pass;

SELECT '0003_required_columns_exist' AS assertion,
  COUNT(*) = 7 AS pass
FROM pragma_table_info('provider_connections')
WHERE name IN ('id', 'provider_key', 'label', 'credential_id', 'status', 'created_at', 'updated_at');

SELECT '0003_credential_fk_exists' AS assertion,
  COUNT(*) = 1 AS pass
FROM pragma_foreign_key_list('provider_connections')
WHERE "table" = 'encrypted_credentials' AND "from" = 'credential_id' AND "to" = 'id';

SELECT '0003_status_check_exists' AS assertion,
  EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'provider_connections'
      AND instr(sql, 'status IN (''active'', ''disabled'', ''invalid'')') > 0
  ) AS pass;

SELECT '0003_tracking_row_exists' AS assertion,
  COUNT(*) = 1 AS pass
FROM d1_migrations WHERE name = '0003_provider_connections.sql';
