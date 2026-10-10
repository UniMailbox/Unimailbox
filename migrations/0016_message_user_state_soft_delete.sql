-- migrations/0016_message_user_state_soft_delete.sql — CAP-043 Slice 1.
--
-- Per-user soft-delete state (R-MESSAGE-005). The inbox-list query filters
-- on `COALESCE(mus.is_deleted, 0) = 0` so a user who has never opened the
-- message (and therefore has no `message_user_state` row) still sees it;
-- a soft-delete only takes effect once the DELETE handler UPSERTs the
-- row with `is_deleted = 1` and `deleted_at`.
--
-- Rules enforced here:
--   R-MESSAGE-005  delete state is per-user; lives on message_user_state,
--                  NOT on mailbox_messages (which would be mailbox-level
--                  and violate the rule — D-CAP-043-B).
--   R-DATA-004     PRAGMA foreign_keys = ON remains enforced at the
--                  runtime boundary; no new FK is declared here.
--   R-DATA-005     All new columns are typed (no JSON-in-text).
--
-- Migration tracking (F1): the INSERT OR IGNORE INTO d1_migrations makes
-- apply+track atomic with the schema change.

-- ============================================================================
-- 1. Soft-delete columns on message_user_state.
-- ============================================================================

-- `is_deleted` is a 0/1 boolean column mirroring the table's existing
-- `is_read` shape (R-MESSAGE-005 consistency). The CHECK enforces the
-- boolean domain at the SQL boundary. The DEFAULT 0 means the column is
-- safe to read on every existing row without a backfill.
ALTER TABLE message_user_state ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0
  CHECK (is_deleted IN (0, 1));

-- `deleted_at` is the SQLite datetime string the row was soft-deleted
-- ('YYYY-MM-DD HH:MM:SS' UTC, matching `datetime('now')` per
-- platform/idempotency.ts:sqliteTimestamp). Nullable so the existing
-- rows (which are not deleted) read NULL; only the DELETE handler writes
-- a value. The column is informational — the inbox list filters on
-- `is_deleted`, not on `deleted_at`.
ALTER TABLE message_user_state ADD COLUMN deleted_at TEXT;

-- Index on `is_deleted` so the inbox-list query's WHERE clause stays
-- selective. The existing `message_user_state_user_idx` (user_id) is
-- still the primary access path; this index covers the COALESCE'd filter
-- on the mailbox_messages LEFT JOIN leg.
CREATE INDEX IF NOT EXISTS message_user_state_is_deleted_idx
  ON message_user_state(is_deleted);

-- ============================================================================
-- 2. Migration tracking — atomic with the schema change (F1).
-- ============================================================================
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0016_message_user_state_soft_delete.sql');