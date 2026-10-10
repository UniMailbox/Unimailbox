-- Keep successful expiry cleanup out of future sweeps; legacy rows remain retryable.
ALTER TABLE attachment_uploads ADD COLUMN cleanup_completed_at TEXT;
CREATE INDEX attachment_uploads_cleanup_pending_idx
  ON attachment_uploads(expires_at, id)
  WHERE cleanup_completed_at IS NULL AND status IN ('uploaded', 'expired');
INSERT INTO d1_migrations (name) VALUES ('0032_attachment_cleanup.sql');
