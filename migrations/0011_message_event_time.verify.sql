-- migrations/0011_message_event_time.verify.sql — Verification queries for 0011_message_event_time.sql.
-- Run after migration apply to confirm schema integrity.
--
-- Verification checks:
-- 1. provider_event_time column was added to messages
-- 2. The column is INTEGER (R-DATA-005: typed, indexable, comparable)
-- 3. The new index exists on provider_event_time
-- 4. Migration tracking row exists

-- Verify provider_event_time column was added to messages
SELECT COUNT(*) = 1 FROM pragma_table_info('messages')
WHERE name = 'provider_event_time';

-- Verify the column is INTEGER (R-DATA-005: not text, not json-as-text)
SELECT
  CASE
    WHEN (SELECT type FROM pragma_table_info('messages')
          WHERE name = 'provider_event_time') = 'INTEGER'
    THEN 1
    ELSE 0
  END = 1;

-- Verify the new index exists
SELECT COUNT(*) >= 1 FROM pragma_index_list('messages')
WHERE name = 'messages_provider_event_time_idx';

-- Verify migration tracking row exists
SELECT COUNT(*) = 1 FROM d1_migrations WHERE name = '0011_message_event_time.sql';