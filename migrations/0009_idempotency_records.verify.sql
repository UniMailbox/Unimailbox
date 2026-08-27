-- Verification for 0009_idempotency_records.sql.

SELECT '0009_required_columns_exist' AS assertion,
  COUNT(*) = 9 AS pass
FROM pragma_table_info('idempotency_records')
WHERE name IN ('id', 'actor_id', 'operation', 'idempotency_key', 'request_hash', 'response_status', 'response_json', 'created_at', 'expires_at');

SELECT '0009_unique_index_exists' AS assertion,
  COUNT(*) = 1 AS pass
FROM sqlite_master WHERE type = 'index' AND name = 'idempotency_records_unique';

SELECT '0009_expiry_index_exists' AS assertion,
  COUNT(*) = 1 AS pass
FROM sqlite_master WHERE type = 'index' AND name = 'idempotency_records_expires_at_idx';

SELECT '0009_length_checks_exist' AS assertion,
  EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'idempotency_records'
      AND instr(sql, 'length(actor_id) <= 128') > 0
      AND instr(sql, 'length(operation) <= 128') > 0
      AND instr(sql, 'length(idempotency_key) <= 128') > 0
      AND instr(sql, 'length(request_hash) = 64') > 0
      AND instr(sql, 'length(response_json) <= 65536') > 0
  ) AS pass;

SELECT '0009_status_check_exists' AS assertion,
  EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'idempotency_records'
      AND instr(sql, 'response_status >= 100') > 0
      AND instr(sql, 'response_status < 600') > 0
  ) AS pass;

SELECT '0009_tracking_row_exists' AS assertion,
  COUNT(*) = 1 AS pass
FROM d1_migrations WHERE name = '0009_idempotency_records.sql';
