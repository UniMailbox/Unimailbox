-- migrations/0013_webhook_delivery_message_index.sql — CAP-040 early-event
-- reconciliation (HIGH finding from the 2026-08-19 reality audit).
--
-- Brevo (and every outbound provider) can deliver a webhook event BEFORE
-- the queue consumer has finished sending the message — the provider returns
-- the canonical `providerMessageId` on its send response, and an `accepted`
-- event can fire milliseconds later. The CAP-029 webhook processor resolves
-- `messageId` by joining on `outbound_jobs.provider_message_id`, but the job
-- row may not yet carry the provider id when the event arrives: the consumer
-- writes it on `markOutboundJobSent` AFTER the adapter returns.
--
-- To prevent losing the event when the join misses, the processor now
-- persists the `webhook_deliveries` row with `message_id = NULL` (so the
-- row is durable) and reconciliation back-fills `message_id` once the
-- canonical provider id is known (the new `reconcileWebhookDeliveries` use
-- case runs after `markOutboundJobSent` in `processOutboundJob`).
--
-- The reconciliation lookup is keyed on the provider message id parsed from
-- `raw_payload` — Brevo echoes `messageId` in every event body. Surfacing
-- that value as a STORED generated column makes the lookup indexable without
-- a JSON parse on the hot path; the composite index
-- `(provider_message_id, message_id)` supports the reconciliation query
-- `WHERE provider_message_id = ? AND message_id IS NULL`.
--
-- Rules enforced:
--   R-DATA-005: provider_message_id is TEXT (typed, indexable). The JSON
--     extraction happens at write time inside SQLite, not at read time in
--     application code (no JSON-in-text reads).
--   R-MESSAGE-007 / CAP-029: webhook_deliveries.message_id remains the same
--     nullable FK to messages — the new column does not change the existing
--     join or the rank-aware predicate.
--
-- Migration tracking (F1): the INSERT OR IGNORE INTO d1_migrations makes
-- apply+track atomic with the schema change.

ALTER TABLE webhook_deliveries
  ADD COLUMN provider_message_id TEXT
    GENERATED ALWAYS AS (json_extract(raw_payload, '$.messageId')) STORED;

CREATE INDEX IF NOT EXISTS webhook_deliveries_provider_message_id_idx
  ON webhook_deliveries(provider_message_id, message_id);

INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0013_webhook_delivery_message_index.sql');