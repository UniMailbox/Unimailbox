-- migrations/0022_message_attachments.sql — CAP-050.
-- Consumed attachment relations for a composed message. Owned by the
-- `messages` module. Binary bytes stay in the existing CACHE KV namespace
-- under attachment:<upload_id> (CAP-049); `object_key` records that canonical
-- key so the queue consumer can fetch bytes without re-deriving it.
--
-- Two D1-enforced guards make one-consume-per-upload true under concurrency,
-- rather than relying on a preflight SELECT that two racing compose requests
-- would both pass:
--   1. message_attachments_upload_unique — the second committer's INSERT
--      violates the UNIQUE index, which aborts its whole D1 batch.
--   2. message_attachments_upload_consumable — a BEFORE INSERT trigger that
--      RAISEs unless the new row links the SAME upload to the SAME message
--      owner (R-AUTHZ-004 / R-ATTACHMENT-001) AND that upload is live
--      (R-ATTACHMENT-005), canonical metadata (R-DATA-005), and unexpired
--      (R-ATTACHMENT-007). Closing the consume race plus the
--      ownership-by-message-creator invariant at the schema layer keeps a
--      single compose request from accidentally attaching another user's
--      upload — even if a future preflight bug or route refactor drops the
--      mailbox_id check.

CREATE TABLE IF NOT EXISTS message_attachments (
  id           TEXT    PRIMARY KEY CHECK (length(id) = 36),
  message_id   TEXT    NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  upload_id    TEXT    NOT NULL REFERENCES attachment_uploads(id) ON DELETE RESTRICT,
  object_key   TEXT    NOT NULL CHECK (object_key = 'attachment:' || upload_id),
  filename     TEXT    NOT NULL CHECK (length(filename) BETWEEN 1 AND 255),
  content_type TEXT    NOT NULL CHECK (length(content_type) BETWEEN 3 AND 255),
  size_bytes   INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 5242880),
  disposition  TEXT    NOT NULL DEFAULT 'attachment'
                       CHECK (disposition IN ('attachment', 'inline')),
  content_id   TEXT    CHECK (content_id IS NULL OR length(content_id) BETWEEN 1 AND 255),
  sha256       TEXT    CHECK (sha256 IS NULL OR length(sha256) = 64),
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- R-ATTACHMENT-006: an upload is consumable exactly once, enforced by the
-- database rather than by a read-then-write check.
CREATE UNIQUE INDEX IF NOT EXISTS message_attachments_upload_unique
  ON message_attachments(upload_id);

CREATE INDEX IF NOT EXISTS message_attachments_message_idx
  ON message_attachments(message_id);

-- R-ATTACHMENT-005 + R-ATTACHMENT-006 + R-ATTACHMENT-001 + R-AUTHZ-004 +
-- R-DATA-005 + R-ATTACHMENT-007: reject a message_attachments INSERT unless
-- the new row links the SAME upload to a message whose creator owns that
-- upload (so cross-user attach is impossible at the schema layer), AND
-- the upload is a live `uploaded` row that has not expired, AND every
-- canonical metadata field on the new row matches the upload row's
-- authoritative value (kv_key, size_bytes, filename, content_type,
-- disposition). The implicit `messages.id = NEW.message_id` and
-- `attachment_uploads.id = NEW.upload_id` constraints follow from the
-- JOIN keys — no row matches if either side does not exist.
--
-- Statement order in the compose batch puts this INSERT before the
-- `uploaded` -> `consumed` UPDATE, so the trigger observes the pre-transition
-- status and a replayed/expired/mismatched upload aborts the batch.
CREATE TRIGGER IF NOT EXISTS message_attachments_upload_consumable
BEFORE INSERT ON message_attachments
FOR EACH ROW
WHEN (
  SELECT COUNT(*) FROM attachment_uploads au
  JOIN messages m ON m.id = NEW.message_id
  WHERE au.id = NEW.upload_id
    AND au.owner_user_id = m.created_by_user_id
    AND au.status = 'uploaded'
    AND au.expires_at > datetime('now')
    AND au.kv_key = NEW.object_key
    AND au.size_bytes = NEW.size_bytes
    AND au.filename = NEW.filename
    AND au.content_type = NEW.content_type
    AND au.disposition = NEW.disposition
) = 0
BEGIN
  SELECT RAISE(ABORT, 'ATTACHMENT_UPLOAD_NOT_CONSUMABLE');
END;

-- R-ATTACHMENT-006: `consumed` is terminal for the consume path — only a live
-- `uploaded` row may transition into it, so a second guarded UPDATE that
-- somehow reached the row cannot re-stamp consumed_at.
CREATE TRIGGER IF NOT EXISTS attachment_uploads_consume_once
BEFORE UPDATE OF status ON attachment_uploads
FOR EACH ROW
WHEN NEW.status = 'consumed' AND OLD.status <> 'uploaded'
BEGIN
  SELECT RAISE(ABORT, 'ATTACHMENT_UPLOAD_ALREADY_CONSUMED');
END;

INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0022_message_attachments.sql');