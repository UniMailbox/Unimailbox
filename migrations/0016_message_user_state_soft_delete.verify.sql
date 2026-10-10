-- Verification for 0016_message_user_state_soft_delete.sql.

SELECT '0016_tracking_row_exists' AS assertion,
  COUNT(*) = 1 AS pass
FROM d1_migrations WHERE name = '0016_message_user_state_soft_delete.sql';

SELECT '0016_is_deleted_shape' AS assertion,
  COUNT(*) = 1 AS pass
FROM pragma_table_info('message_user_state')
WHERE name = 'is_deleted' AND "notnull" = 1 AND type = 'INTEGER' AND dflt_value = '0';

SELECT '0016_is_deleted_check_exists' AS assertion,
  EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'message_user_state'
      AND sql LIKE '%is_deleted%CHECK%(is_deleted%IN%(0%,%1%))%'
  ) AS pass;

SELECT '0016_deleted_at_shape' AS assertion,
  COUNT(*) = 1 AS pass
FROM pragma_table_info('message_user_state')
WHERE name = 'deleted_at' AND "notnull" = 0 AND type = 'TEXT';

SELECT '0016_existing_rows_default_not_deleted' AS assertion,
  COUNT(*) = (SELECT COUNT(*) FROM message_user_state) AS pass
FROM message_user_state WHERE is_deleted = 0;

SELECT '0016_is_deleted_index_exists' AS assertion,
  COUNT(*) = 1 AS pass
FROM sqlite_master WHERE type = 'index' AND name = 'message_user_state_is_deleted_idx';

SELECT '0016_no_unique_is_deleted_index' AS assertion,
  COUNT(*) = 0 AS pass
FROM pragma_index_list('message_user_state')
WHERE "unique" = 1 AND name LIKE '%is_deleted%';
