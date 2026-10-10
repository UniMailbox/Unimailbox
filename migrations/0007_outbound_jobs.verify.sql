-- Verification for 0007_outbound_jobs.sql.

SELECT '0007_table_exists' AS assertion,
  EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'outbound_jobs') AS pass;

SELECT '0007_required_columns_exist' AS assertion,
  COUNT(*) = 13 AS pass
FROM pragma_table_info('outbound_jobs')
WHERE name IN ('id', 'message_id', 'provider_connection_id', 'status', 'attempts', 'max_attempts', 'locked_at', 'locked_by', 'provider_message_id', 'error_code', 'error_message', 'created_at', 'updated_at');

SELECT '0007_named_indexes_exist' AS assertion,
  COUNT(*) = 2 AS pass
FROM sqlite_master
WHERE type = 'index' AND name IN ('outbound_jobs_status_idx', 'outbound_jobs_message_idx');

SELECT '0007_foreign_keys_exist' AS assertion,
  COUNT(*) = 2 AS pass
FROM pragma_foreign_key_list('outbound_jobs')
WHERE on_delete = 'CASCADE';

SELECT '0007_tracking_row_exists' AS assertion,
  COUNT(*) = 1 AS pass
FROM d1_migrations WHERE name = '0007_outbound_jobs.sql';
