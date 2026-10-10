-- Structural verification; worker tests cover the backfill and replay.
SELECT '0027_projection_columns' AS assertion, COUNT(*) = 2 AS pass
  FROM pragma_table_info('webhook_deliveries')
 WHERE name IN ('verified_provider_message_id', 'message_status');

SELECT '0027_projection_index' AS assertion, COUNT(*) = 1 AS pass
  FROM sqlite_master
 WHERE type = 'index' AND name = 'webhook_deliveries_verified_message_idx';

SELECT '0027_tracking_row' AS assertion, COUNT(*) = 1 AS pass
  FROM d1_migrations WHERE name = '0027_webhook_event_projection.sql';
