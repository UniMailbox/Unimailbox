-- migrations/0021_attachment_uploads.sql — CAP-049.
-- Temporary attachment staging metadata. Binary bytes live in the existing
-- CACHE KV namespace under attachment:<upload_id>; D1 remains authoritative
-- for ownership, mailbox scope, lifecycle state, and expiry.

CREATE TABLE IF NOT EXISTS attachment_uploads (
  id             TEXT    PRIMARY KEY CHECK (length(id) = 36),
  owner_user_id  TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mailbox_id     TEXT    NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  kv_key         TEXT    NOT NULL CHECK (kv_key = 'attachment:' || id),
  filename       TEXT    NOT NULL CHECK (length(filename) BETWEEN 1 AND 255),
  content_type   TEXT    NOT NULL CHECK (length(content_type) BETWEEN 3 AND 255),
  disposition    TEXT    NOT NULL DEFAULT 'attachment'
                         CHECK (disposition IN ('attachment', 'inline')),
  size_bytes     INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 5242880),
  status         TEXT    NOT NULL CHECK (status IN ('uploaded', 'consumed', 'expired')),
  expires_at     TEXT    NOT NULL,
  consumed_at    TEXT,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS attachment_uploads_kv_key_unique
  ON attachment_uploads(kv_key);

CREATE INDEX IF NOT EXISTS attachment_uploads_owner_idx
  ON attachment_uploads(owner_user_id);

CREATE INDEX IF NOT EXISTS attachment_uploads_mailbox_idx
  ON attachment_uploads(mailbox_id);

CREATE INDEX IF NOT EXISTS attachment_uploads_expires_at_idx
  ON attachment_uploads(expires_at);

INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0021_attachment_uploads.sql');
