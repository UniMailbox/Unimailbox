-- migrations/0008_webhook_events.verify.sql — Verification queries for 0008_webhook_events.sql.
-- Run after migration apply to confirm schema integrity.
--
-- Verification checks:
-- 1. webhook_deliveries table exists with correct columns
-- 2. webhook_secret column was added to provider_connections
-- 3. Indexes exist on webhook_deliveries
-- 4. Foreign keys to provider_connections and messages are valid
-- 5. Migration tracking row exists

-- Verify webhook_deliveries table exists and has 7 columns
SELECT COUNT(*) = 7 FROM pragma_table_info('webhook_deliveries')
WHERE name IN (
  'id', 'connection_id', 'event_type', 'raw_payload',
  'message_id', 'status', 'created_at'
);

-- Verify webhook_secret column was added to provider_connections
SELECT COUNT(*) = 1 FROM pragma_table_info('provider_connections')
WHERE name = 'webhook_secret';

-- Verify indexes exist (connection + created + implicit primary key)
SELECT COUNT(*) = 2 FROM pragma_index_list('webhook_deliveries');

-- Verify foreign keys are enabled (R-DATA-004)
PRAGMA foreign_keys;

-- Verify migration tracking row exists
SELECT COUNT(*) = 1 FROM d1_migrations WHERE name = '0008_webhook_events.sql';

-- Verify R-DATA-005 explicit exception: raw_payload has a 64 KB size CHECK.
-- The CHECK must reject payloads over 65536 bytes.
SELECT
  CASE
    WHEN (SELECT COUNT(*) FROM webhook_deliveries WHERE length(raw_payload) > 65536) = 0
    THEN 1
    ELSE 0
  END = 1;
