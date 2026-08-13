-- migrations/0006_messages.sql — Messages module tables.
-- CAP-021: Inbound mail — stores parsed emails and mailbox associations.
-- Authoritative; reviewed by hand. Drizzle schemas in apps/worker/src/database/schema/messages.ts
-- are typing only and must not be used to regenerate this file.
--
-- Rules enforced:
--   R-INBOUND-008: Message + recipients + mailbox_messages inserted in one D1 batch
--   R-DATA-004: PRAGMA foreign_keys = ON (D1 default)
--
-- Migration tracking (F1): CREATE TABLE IF NOT EXISTS d1_migrations then
-- INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0006_messages.sql')
-- ensures apply+track are atomic.

-- ============================================================
-- Messages: Core message storage
-- ============================================================
CREATE TABLE IF NOT EXISTS messages (
  id                  TEXT PRIMARY KEY,
  thread_id           TEXT,
  from_address        TEXT NOT NULL,
  from_name           TEXT NOT NULL DEFAULT '',
  subject             TEXT NOT NULL DEFAULT '',
  html_body           TEXT NOT NULL DEFAULT '',
  text_body           TEXT NOT NULL DEFAULT '',
  message_id_header   TEXT,
  in_reply_to_header  TEXT,
  references_header   TEXT NOT NULL DEFAULT '',
  status              TEXT NOT NULL CHECK (status IN ('draft','queued','sending','sent','delivered','delayed','bounced','complained','failed')) DEFAULT 'delivered',
  error_code          TEXT,
  error_message       TEXT,
  raw_object_key      TEXT,
  created_by_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  received_at         TEXT,
  sent_at             TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS messages_thread_id_idx ON messages(thread_id);
CREATE INDEX IF NOT EXISTS messages_from_address_idx ON messages(from_address);
CREATE INDEX IF NOT EXISTS messages_status_idx ON messages(status);
CREATE INDEX IF NOT EXISTS messages_created_at_idx ON messages(created_at DESC);

-- ============================================================
-- Message recipients: To/Cc/Bcc addresses
-- ============================================================
CREATE TABLE IF NOT EXISTS message_recipients (
  id            TEXT PRIMARY KEY,
  message_id    TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  address       TEXT NOT NULL,
  display_name  TEXT NOT NULL DEFAULT '',
  type          TEXT NOT NULL CHECK (type IN ('to', 'cc', 'bcc')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS message_recipients_message_idx ON message_recipients(message_id);

-- ============================================================
-- Mailbox messages: Associates messages with mailboxes
-- ============================================================
CREATE TABLE IF NOT EXISTS mailbox_messages (
  id            TEXT PRIMARY KEY,
  mailbox_id    TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  message_id    TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  is_read       INTEGER NOT NULL DEFAULT 0,
  is_starred    INTEGER NOT NULL DEFAULT 0,
  folder        TEXT NOT NULL DEFAULT 'inbox',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(mailbox_id, message_id)
);
CREATE INDEX IF NOT EXISTS mailbox_messages_mailbox_idx ON mailbox_messages(mailbox_id);
CREATE INDEX IF NOT EXISTS mailbox_messages_message_idx ON mailbox_messages(message_id);

-- ============================================================
-- Message user state: Per-user read/unread tracking
-- ============================================================
CREATE TABLE IF NOT EXISTS message_user_state (
  mailbox_message_id TEXT PRIMARY KEY REFERENCES mailbox_messages(id) ON DELETE CASCADE,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_read            INTEGER NOT NULL DEFAULT 0,
  read_at            TEXT,
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS message_user_state_user_idx ON message_user_state(user_id);

-- ============================================================
-- Migration tracking (F1)
-- ============================================================
CREATE TABLE IF NOT EXISTS d1_migrations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE CHECK (length(name) <= 256),
  applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0006_messages.sql');
