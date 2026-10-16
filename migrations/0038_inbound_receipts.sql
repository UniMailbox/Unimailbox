-- Accepted inbound work survives failures between R2, D1 and Queue.
CREATE TABLE IF NOT EXISTS inbound_receipts (
  id TEXT PRIMARY KEY NOT NULL,
  dedup_key TEXT NOT NULL UNIQUE CHECK (length(dedup_key) = 64),
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  envelope_from TEXT NOT NULL,
  envelope_to TEXT NOT NULL,
  raw_object_key TEXT NOT NULL UNIQUE,
  raw_sha256 TEXT NOT NULL CHECK (length(raw_sha256) = 64),
  raw_size INTEGER NOT NULL CHECK (raw_size >= 0 AND raw_size <= 26214400),
  request_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  locked_by TEXT,
  lease_until TEXT,
  next_attempt_at TEXT NOT NULL,
  dispatch_after TEXT NOT NULL,
  last_error_code TEXT CHECK (last_error_code IS NULL OR last_error_code = 'INBOUND_PROCESSING_FAILED'),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK ((status = 'processing' AND locked_by IS NOT NULL AND lease_until IS NOT NULL)
    OR (status != 'processing' AND locked_by IS NULL AND lease_until IS NULL)),
  CHECK ((status = 'completed' AND completed_at IS NOT NULL)
    OR (status != 'completed' AND completed_at IS NULL))
);
CREATE INDEX IF NOT EXISTS inbound_receipts_pending_idx
  ON inbound_receipts(next_attempt_at, dispatch_after) WHERE status='pending';
CREATE INDEX IF NOT EXISTS inbound_receipts_processing_idx
  ON inbound_receipts(lease_until, dispatch_after) WHERE status='processing';
CREATE INDEX IF NOT EXISTS inbound_receipts_completed_idx
  ON inbound_receipts(status, completed_at);
CREATE INDEX IF NOT EXISTS inbound_receipts_incomplete_age_idx
  ON inbound_receipts(created_at) WHERE status!='completed';
INSERT OR IGNORE INTO d1_migrations(name) VALUES ('0038_inbound_receipts.sql');
