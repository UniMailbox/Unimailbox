-- 0028_inbound_attachments.sql — received MIME attachment metadata.
-- Inbound parts are not user uploads and must not enter the one-consume
-- attachment_uploads lifecycle. Bytes live privately in R2; metadata is
-- linked to the canonical message and exposed only through mailbox grants.

CREATE TABLE IF NOT EXISTS inbound_message_attachments (
  id           TEXT PRIMARY KEY CHECK (length(id) = 36),
  message_id   TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  object_key   TEXT NOT NULL UNIQUE CHECK (object_key LIKE 'inbound-attachment/%'),
  filename     TEXT NOT NULL CHECK (length(filename) BETWEEN 1 AND 255),
  content_type TEXT NOT NULL CHECK (length(content_type) BETWEEN 3 AND 255),
  size_bytes   INTEGER NOT NULL CHECK (size_bytes BETWEEN 0 AND 26214400),
  disposition  TEXT NOT NULL CHECK (disposition IN ('attachment', 'inline')),
  content_id   TEXT CHECK (content_id IS NULL OR length(content_id) BETWEEN 1 AND 255),
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS inbound_message_attachments_message_idx
  ON inbound_message_attachments(message_id, created_at, id);

INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0028_inbound_attachments.sql');
