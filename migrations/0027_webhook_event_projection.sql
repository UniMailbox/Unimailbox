-- 0027_webhook_event_projection.sql — provider-neutral early-event replay.
-- Keep the legacy Brevo-only generated provider_message_id column for schema
-- compatibility, but use these verified adapter projections for all new
-- webhook writes and reconciliation lookups. Existing Brevo rows are backfilled
-- once so unmatched events remain replayable after the application switches.

ALTER TABLE webhook_deliveries ADD COLUMN verified_provider_message_id TEXT;
ALTER TABLE webhook_deliveries ADD COLUMN message_status TEXT
  CHECK (message_status IN ('draft','queued','sending','sent','delivered','delayed','bounced','complained','failed')
         OR message_status IS NULL);

UPDATE webhook_deliveries
   SET verified_provider_message_id = provider_message_id,
       message_status = CASE event_type
         WHEN 'delivered' THEN 'delivered'
         WHEN 'bounce' THEN 'bounced'
         WHEN 'hard_bounce' THEN 'bounced'
         WHEN 'soft_bounce' THEN 'bounced'
         WHEN 'complaint' THEN 'complained'
         WHEN 'spam' THEN 'complained'
         WHEN 'delayed' THEN 'delayed'
         WHEN 'blocked' THEN 'delayed'
         ELSE NULL
       END
 WHERE connection_id IN (
   SELECT id FROM provider_connections WHERE provider_key = 'brevo'
 );

CREATE INDEX IF NOT EXISTS webhook_deliveries_verified_message_idx
  ON webhook_deliveries(connection_id, verified_provider_message_id, message_id)
  WHERE verified_provider_message_id IS NOT NULL AND message_id IS NULL;

INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0027_webhook_event_projection.sql');
