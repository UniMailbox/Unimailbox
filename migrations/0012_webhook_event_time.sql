-- migrations/0012_webhook_event_time.sql — CAP-029 webhook ordering (Q1).
-- Adds `event_time` and `event_time_source` columns to webhook_deliveries so the
-- audit trail records which timestamp drove R-MESSAGE-007 ordering:
--   - `event_time` is the epoch-ms value the processor used for the rank-aware
--     predicate (provider-supplied or server fallback). It is nullable because
--     some event payloads carry no timestamp and we choose to skip the write
--     in that case (server fallback remains valid; NULL here means "no
--     ordering claim was made").
--   - `event_time_source` is 'provider' when the payload supplied a timestamp
--     we trust, 'server' when we fell back to wall-clock at receipt. The
--     closure makes audit queries answerable: "which webhooks were ordered
--     against server time?" — silently falling back would have hidden that.
--
-- Rules enforced:
--   R-DATA-005: event_time is INTEGER (Unix epoch ms) — typed, indexable,
--     comparable. NOT JSON-in-text.
--   R-AUDIT-001: every webhook delivery row records enough metadata to
--     reconstruct the ordering decision later.
--
-- Migration tracking (F1): the INSERT OR IGNORE INTO d1_migrations makes
-- apply+track atomic with the schema change.

ALTER TABLE webhook_deliveries ADD COLUMN event_time INTEGER;
ALTER TABLE webhook_deliveries ADD COLUMN event_time_source TEXT
  CHECK (event_time_source IN ('provider', 'server') OR event_time_source IS NULL);

-- Index supports audit queries that filter by provider-supplied time (e.g.
-- "all events for connection X within [a, b]"). Single-row writes don't need
-- this; fan-out queries do.
CREATE INDEX IF NOT EXISTS webhook_deliveries_event_time_idx
  ON webhook_deliveries(event_time);

INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0012_webhook_event_time.sql');