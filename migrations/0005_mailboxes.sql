-- 0005_mailboxes.sql
-- CAP-020: Mailboxes and mailbox members tables
--
-- mailboxes stores mailbox entities owned by users.
-- mailbox_members stores role-based sharing (viewer, sender, admin).
--
-- R-DATA-001: local_part is case-insensitive (COLLATE NOCASE).
-- R-MAILBOX-003: Owner is implicitly a member; no explicit row needed.
--
-- Migration tracking (F1): the INSERT OR IGNORE INTO d1_migrations makes
-- apply+track atomic with the CREATE TABLE.

CREATE TABLE IF NOT EXISTS mailboxes (
  id            TEXT PRIMARY KEY,
  domain_id     TEXT NOT NULL REFERENCES managed_domains(id),
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  local_part    TEXT NOT NULL,
  display_name  TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'deleted')) DEFAULT 'active',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at    TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS mailboxes_domain_local_unique ON mailboxes(domain_id, local_part COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS mailboxes_owner_idx ON mailboxes(owner_user_id);

CREATE TABLE IF NOT EXISTS mailbox_members (
  mailbox_id  TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('viewer', 'sender', 'admin')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (mailbox_id, user_id)
);

INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0005_mailboxes.sql');
