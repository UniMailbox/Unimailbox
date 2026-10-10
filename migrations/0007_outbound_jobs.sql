-- migrations/0007_outbound_jobs.sql — CAP-023 outbound jobs table.
-- Stores one row per outbound message: the bridge between compose (writes a
-- 'queued' job) and the queue consumer (sends via the Brevo adapter and
-- marks the job + message 'sent').
--
-- Rules enforced:
--   R-OUTBOUND-006: send + outbound_jobs + idempotency write in one D1 batch
--                  (idempotency_records deferred to CAP-027; the batch shape
--                  is already in place here).
--   R-DATA-004: PRAGMA foreign_keys = ON (D1 default)
--
-- Migration tracking (F1): the INSERT OR IGNORE INTO d1_migrations makes
-- apply+track atomic with the CREATE TABLE.

CREATE TABLE IF NOT EXISTS outbound_jobs (
  id                      TEXT PRIMARY KEY,
  message_id              TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  provider_connection_id  TEXT NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
  status                  TEXT NOT NULL CHECK (status IN ('queued','sending','sent','delayed','bounced','complained','failed')) DEFAULT 'queued',
  attempts                INTEGER NOT NULL DEFAULT 0,
  max_attempts            INTEGER NOT NULL DEFAULT 3,
  locked_at               TEXT,
  locked_by               TEXT,
  provider_message_id     TEXT,
  error_code              TEXT,
  error_message           TEXT,
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS outbound_jobs_status_idx ON outbound_jobs(status);
CREATE INDEX IF NOT EXISTS outbound_jobs_message_idx ON outbound_jobs(message_id);

INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0007_outbound_jobs.sql');
