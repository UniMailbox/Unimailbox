-- Verification for 0013_webhook_delivery_message_index.sql.
-- The generated-column expression is verified structurally; the worker upgrade
-- suite owns the load-bearing write/read behavior without mutating production
-- data from an operator verification script.

SELECT '0013_generated_column_exists' AS assertion,
  COUNT(*) = 1 AS pass
FROM pragma_table_xinfo('webhook_deliveries')
WHERE name = 'provider_message_id' AND type = 'TEXT' AND hidden IN (2, 3);

SELECT '0013_generated_expression_exists' AS assertion,
  EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'webhook_deliveries'
      AND instr(sql, 'provider_message_id TEXT') > 0
      AND instr(sql, 'json_extract(raw_payload, ''$.messageId'')') > 0
  ) AS pass;

SELECT '0013_composite_index_exists' AS assertion,
  COUNT(*) = 1 AS pass
FROM sqlite_master
WHERE type = 'index' AND name = 'webhook_deliveries_provider_message_id_idx';

SELECT '0013_composite_index_columns' AS assertion,
  GROUP_CONCAT(name, ',') = 'provider_message_id,message_id' AS pass
FROM pragma_index_info('webhook_deliveries_provider_message_id_idx');

SELECT '0013_tracking_row_exists' AS assertion,
  COUNT(*) = 1 AS pass
FROM d1_migrations WHERE name = '0013_webhook_delivery_message_index.sql';
