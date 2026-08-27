-- Verification for 0012_webhook_event_time.sql.

SELECT '0012_event_time_shape' AS assertion,
  COUNT(*) = 1 AS pass
FROM pragma_table_info('webhook_deliveries')
WHERE name = 'event_time' AND type = 'INTEGER';

SELECT '0012_event_time_source_shape' AS assertion,
  COUNT(*) = 1 AS pass
FROM pragma_table_info('webhook_deliveries')
WHERE name = 'event_time_source' AND type = 'TEXT';

SELECT '0012_event_time_source_check_exists' AS assertion,
  EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'webhook_deliveries'
      AND instr(sql, 'event_time_source') > 0
      AND instr(sql, 'event_time_source IN (''provider'', ''server'')') > 0
  ) AS pass;

SELECT '0012_event_time_index_exists' AS assertion,
  COUNT(*) = 1 AS pass
FROM sqlite_master WHERE type = 'index' AND name = 'webhook_deliveries_event_time_idx';

SELECT '0012_tracking_row_exists' AS assertion,
  COUNT(*) = 1 AS pass
FROM d1_migrations WHERE name = '0012_webhook_event_time.sql';
