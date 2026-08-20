-- migrations/0013_webhook_delivery_message_index.verify.sql — Verification
-- queries for 0013_webhook_delivery_message_index.sql.
--
-- Verification checks:
-- 1. provider_message_id column was added to webhook_deliveries
-- 2. The composite index exists
-- 3. The generated column is populated when raw_payload contains messageId
-- 4. The find-unmatched query returns rows with message_id IS NULL
-- 5. Migration tracking row exists

-- Verify provider_message_id column was added
SELECT COUNT(*) = 1 FROM pragma_table_info('webhook_deliveries')
WHERE name = 'provider_message_id';

-- Verify the composite index exists
SELECT COUNT(*) >= 1 FROM pragma_index_list('webhook_deliveries')
WHERE name = 'webhook_deliveries_provider_message_id_idx';

-- Verify the generated column populates from raw_payload.messageId.
-- We insert a stub row whose raw_payload contains a known messageId, then
-- assert the generated column mirrors it. The stub row is cleaned up at
-- the end of this verify script.
INSERT INTO webhook_deliveries (
  id, connection_id, event_type, raw_payload, message_id, status, created_at
) VALUES (
  'verify-stub-0013', 'verify-conn-0013', 'verify', '{"messageId":"brevo-msg-verify"}', NULL, 'processed', '2026-01-01 00:00:00'
);

SELECT COUNT(*) = 1 FROM webhook_deliveries
WHERE id = 'verify-stub-0013' AND provider_message_id = 'brevo-msg-verify';

-- Verify the find-unmatched reconciliation query returns rows whose
-- message_id is NULL but provider_message_id matches.
SELECT COUNT(*) = 1 FROM webhook_deliveries
WHERE provider_message_id = 'brevo-msg-verify' AND message_id IS NULL;

-- Clean up the stub.
DELETE FROM webhook_deliveries WHERE id = 'verify-stub-0013';

-- Migration tracking row exists.
SELECT COUNT(*) = 1 FROM d1_migrations WHERE name = '0013_webhook_delivery_message_index.sql';