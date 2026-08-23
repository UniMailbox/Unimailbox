-- migrations/0017_message_user_state_composite_pk.sql — CAP-043 Slice 1
-- fix pass (D-CAP-043-F).
--
-- Rebuilds message_user_state with PRIMARY KEY (mailbox_message_id, user_id).
--
-- Why: the 0006 schema made `mailbox_message_id` the sole PRIMARY KEY — one
-- row per mailbox message, not one row per user. That contradicts
-- R-MESSAGE-005 (read / star / delete state is per-user) in two ways:
--
--   1. markMessageAsRead's UPSERT conflicted on `mailbox_message_id` alone,
--      so a second member reading a shared message never got their own row
--      and their read state was silently dropped (message shows unread
--      forever for everyone except the first reader).
--   2. A per-user `is_deleted` column (0016 / D-CAP-043-B) on a table that
--      can hold only one user's row would clobber the other member's state.
--
-- SQLite cannot ALTER a PRIMARY KEY, so the migration follows the standard
-- rebuild: create the new table, copy, drop the old, rename, recreate
-- indexes. The copy is lossless — the single-column PK guarantees no
-- `(mailbox_message_id, user_id)` duplicates exist today, so every old row
-- fits the composite PK unchanged.
--
-- The table is an FK *child* only (nothing references message_user_state),
-- so DROP TABLE is safe with PRAGMA foreign_keys = ON (R-DATA-004).
--
-- Columns, defaults, and CHECKs are carried over verbatim from
-- 0006_messages.sql + 0016_message_user_state_soft_delete.sql; column order
-- matches the old table (0016's ALTER TABLE ADD COLUMN appended
-- is_deleted / deleted_at last).
--
-- Rules enforced here:
--   R-MESSAGE-005  per-user state rows: one row per (mailbox_message, user).
--   R-DATA-004     PRAGMA foreign_keys = ON remains enforced at the runtime
--                  boundary; both 0006 FK CASCADEs are redeclared.
--
-- Migration tracking (F1): the INSERT OR IGNORE INTO d1_migrations makes
-- apply+track atomic with the schema change.

-- ============================================================================
-- 1. Rebuild with the composite PK.
-- ============================================================================
CREATE TABLE message_user_state_new (
  mailbox_message_id TEXT NOT NULL REFERENCES mailbox_messages(id) ON DELETE CASCADE,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_read            INTEGER NOT NULL DEFAULT 0,
  read_at            TEXT,
  updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
  is_deleted         INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
  deleted_at         TEXT,
  PRIMARY KEY (mailbox_message_id, user_id)
);

INSERT INTO message_user_state_new (mailbox_message_id, user_id, is_read, read_at, updated_at, is_deleted, deleted_at)
SELECT mailbox_message_id, user_id, is_read, read_at, updated_at, is_deleted, deleted_at
  FROM message_user_state;

DROP TABLE message_user_state;

ALTER TABLE message_user_state_new RENAME TO message_user_state;

-- ============================================================================
-- 2. Recreate both indexes (DROP TABLE dropped them with the old table).
-- ============================================================================
CREATE INDEX IF NOT EXISTS message_user_state_user_idx ON message_user_state(user_id);
CREATE INDEX IF NOT EXISTS message_user_state_is_deleted_idx ON message_user_state(is_deleted);

-- ============================================================================
-- 3. Migration tracking — atomic with the schema change (F1).
-- ============================================================================
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0017_message_user_state_composite_pk.sql');
