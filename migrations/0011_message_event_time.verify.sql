-- Verification for 0011_message_event_time.sql.

SELECT '0011_provider_event_time_shape' AS assertion,
  COUNT(*) = 1 AS pass
FROM pragma_table_info('messages')
WHERE name = 'provider_event_time' AND type = 'INTEGER';

SELECT '0011_provider_event_time_index_exists' AS assertion,
  COUNT(*) = 1 AS pass
FROM sqlite_master WHERE type = 'index' AND name = 'messages_provider_event_time_idx';

SELECT '0011_tracking_row_exists' AS assertion,
  COUNT(*) = 1 AS pass
FROM d1_migrations WHERE name = '0011_message_event_time.sql';
