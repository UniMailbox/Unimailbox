ALTER TABLE outbound_jobs ADD COLUMN next_attempt_at TEXT;
CREATE TABLE IF NOT EXISTS outbound_send_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  job_id TEXT NOT NULL REFERENCES outbound_jobs(id) ON DELETE CASCADE,
  provider_key TEXT NOT NULL,
  correlated INTEGER NOT NULL DEFAULT 1 CHECK (correlated IN (0,1)),
  status TEXT NOT NULL CHECK (status IN ('prepared','submitted','accepted','unknown','rejected')),
  provider_message_id TEXT,
  accepted_at TEXT,
  started_at TEXT NOT NULL,
  submitted_at TEXT,
  resolved_at TEXT,
  request_id TEXT,
  next_reconcile_at TEXT,
  reconciliation_checks INTEGER NOT NULL DEFAULT 0 CHECK (reconciliation_checks >= 0),
  CHECK (status!='accepted' OR (provider_message_id IS NOT NULL AND accepted_at IS NOT NULL))
);
CREATE UNIQUE INDEX outbound_one_unresolved_attempt
  ON outbound_send_attempts(job_id) WHERE status IN ('submitted','unknown','accepted');
CREATE INDEX outbound_attempts_job_idx ON outbound_send_attempts(job_id, started_at);
CREATE INDEX outbound_attempts_reconcile_idx
  ON outbound_send_attempts(status,next_reconcile_at) WHERE next_reconcile_at IS NOT NULL;
CREATE INDEX outbound_jobs_next_attempt_idx
  ON outbound_jobs(next_attempt_at) WHERE status='queued';
-- Old in-flight work has no durable boundary or transmitted attempt tag.
-- Quarantine it rather than assuming an expired legacy lease permits a resend.
INSERT INTO outbound_send_attempts(id,job_id,provider_key,correlated,status,provider_message_id,
  accepted_at,started_at,submitted_at,next_reconcile_at)
SELECT j.id,j.id,c.provider_key,0,
  CASE WHEN j.provider_message_id IS NOT NULL THEN 'accepted' ELSE 'unknown' END,
  j.provider_message_id,
  CASE WHEN j.provider_message_id IS NOT NULL THEN strftime('%Y-%m-%dT%H:%M:%fZ',COALESCE(m.sent_at,j.updated_at)) END,
  j.updated_at,j.updated_at,
  CASE WHEN j.provider_message_id IS NOT NULL THEN datetime('now') END
FROM outbound_jobs j JOIN provider_connections c ON c.id=j.provider_connection_id
JOIN messages m ON m.id=j.message_id WHERE j.status='sending'
  OR (j.status='queued' AND (j.scheduled_at IS NULL OR j.scheduled_at<=datetime('now')));
UPDATE outbound_jobs SET status='sending',error_code='SEND_OUTCOME_UNKNOWN',
  error_message='Legacy in-flight submission requires reconciliation',locked_at=NULL,locked_by=NULL
WHERE id IN (SELECT job_id FROM outbound_send_attempts WHERE correlated=0 AND status='unknown');
INSERT OR IGNORE INTO d1_migrations(name) VALUES ('0039_outbound_send_attempts.sql');
