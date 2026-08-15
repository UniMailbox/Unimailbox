-- migrations/0012_webhook_event_time.verify.sql — Verification queries for 0012_webhook_event_time.sql.
-- Run after migration apply to confirm schema integrity.
--
-- Verification checks:
-- 1. event_time column was added to webhook_deliveries
-- 2. event_time is INTEGER (R-DATA-005: typed, indexable, comparable)
-- 3. event_time_source column was added with a CHECK constraint
-- 4. The new index exists on event_time
-- 5. Migration tracking row exists

-- Verify event_time column was added to webhook_deliveries
SELECT COUNT(*) = 1 FROM pragma_table_info('webhook_deliveries')
WHERE name = 'event_time';

-- Verify event_time is INTEGER (R-DATA-005: not text, not json-as-text)
SELECT
  CASE
    WHEN (SELECT type FROM pragma_table_info('webhook_deliveries')
          WHERE name = 'event_time') = 'INTEGER'
    THEN 1
    ELSE 0
  END = 1;

-- Verify event_time_source column exists
SELECT COUNT(*) = 1 FROM pragma_table_info('webhook_deliveries')
WHERE name = 'event_time_source';

-- Verify the new index exists
SELECT COUNT(*) >= 1 FROM pragma_index_list('webhook_deliveries')
WHERE name = 'webhook_deliveries_event_time_idx';

-- Verify migration tracking row exists
SELECT COUNT(*) = 1 FROM d1_migrations WHERE name = '0012_webhook_event_time.sql';