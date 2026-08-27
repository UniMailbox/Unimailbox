-- Verification for 0008_webhook_events.sql.

SELECT '0008_table_exists' AS assertion,
  EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'webhook_deliveries') AS pass;

SELECT '0008_required_columns_exist' AS assertion,
  COUNT(*) = 7 AS pass
FROM pragma_table_info('webhook_deliveries')
WHERE name IN ('id', 'connection_id', 'event_type', 'raw_payload', 'message_id', 'status', 'created_at');

SELECT '0008_webhook_secret_column_exists' AS assertion,
  COUNT(*) = 1 AS pass
FROM pragma_table_info('provider_connections') WHERE name = 'webhook_secret';

SELECT '0008_named_indexes_exist' AS assertion,
  COUNT(*) = 2 AS pass
FROM sqlite_master
WHERE type = 'index' AND name IN ('webhook_deliveries_connection_idx', 'webhook_deliveries_created_idx');

SELECT '0008_foreign_keys_exist' AS assertion,
  COUNT(*) = 2 AS pass
FROM pragma_foreign_key_list('webhook_deliveries');

SELECT '0008_raw_payload_size_check_exists' AS assertion,
  EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'webhook_deliveries'
      AND instr(sql, 'length(raw_payload) <= 65536') > 0
  ) AS pass;

SELECT '0008_tracking_row_exists' AS assertion,
  COUNT(*) = 1 AS pass
FROM d1_migrations WHERE name = '0008_webhook_events.sql';
