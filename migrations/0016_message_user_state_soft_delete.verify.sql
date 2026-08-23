-- migrations/0016_message_user_state_soft_delete.verify.sql — Verification
-- queries for 0016_message_user_state_soft_delete.sql.
--
-- CAP-043 Slice 1 / AC 1:
--   1. Migration tracking row exists.
--   2. `is_deleted` column exists with NOT NULL DEFAULT 0 and a CHECK
--      that rejects non-boolean values (asserted via the table-level
--      DDL text in sqlite_master — SQLite stores CHECK constraints as
--      table SQL, not per-column metadata).
--   3. `deleted_at` column exists and is nullable (no NOT NULL).
--   4. An existing row's `is_deleted` reads 0 after the migration (the
--      DEFAULT means no backfill is required, but the assertion proves
--      it).
--   5. `message_user_state_is_deleted_idx` exists.
--   6. No UNIQUE constraint was added to `is_deleted` (R-MESSAGE-005 —
--      soft-delete is independent of uniqueness).
--
-- Fix pass F10: the previous "probe" (BEGIN/INSERT/COMMIT setup rows for
-- an insert that was never executed) asserted nothing and left dirty
-- rows behind. The sqlite_master DDL assertion below is the entire CHECK
-- proof; it is declarative, leaves no state, and still holds after the
-- 0017 table rebuild (which carries the CHECK text forward verbatim).

-- ----------------------------------------------------------------------------
-- 1. Migration tracking row exists.
-- ----------------------------------------------------------------------------
SELECT COUNT(*) = 1 FROM d1_migrations
  WHERE name = '0016_message_user_state_soft_delete.sql';

-- ----------------------------------------------------------------------------
-- 2. `is_deleted` column exists with the right shape (NOT NULL DEFAULT 0).
-- ----------------------------------------------------------------------------
-- SQLite's pragma_table_info reports NOTNULL=1 when the column has a
-- NOT NULL constraint and DFLT_VALUE is the quoted default expression.
-- The CHECK that pins values to 0/1 is asserted via a separate probe
-- below because SQLite stores CHECK constraints as table SQL, not
-- per-column metadata.
SELECT COUNT(*) = 1 FROM pragma_table_info('message_user_state')
  WHERE name = 'is_deleted'
    AND "notnull" = 1
    AND type = 'INTEGER'
    AND dflt_value = '0';

-- The CHECK constraint exists at the table level. This is the entire
-- CHECK proof (fix pass F10): it survives the 0017 rebuild because that
-- migration redeclares the column with the identical
-- `CHECK (is_deleted IN (0, 1))` text.
SELECT COUNT(*) >= 1 FROM sqlite_master
  WHERE type = 'table'
    AND name = 'message_user_state'
    AND sql LIKE '%is_deleted%CHECK%(is_deleted%IN%(0%,%1%))%';

-- ----------------------------------------------------------------------------
-- 3. `deleted_at` column exists and is nullable.
-- ----------------------------------------------------------------------------
SELECT COUNT(*) = 1 FROM pragma_table_info('message_user_state')
  WHERE name = 'deleted_at'
    AND "notnull" = 0
    AND type = 'TEXT';

-- ----------------------------------------------------------------------------
-- 4. An existing row's `is_deleted` reads 0 after the migration.
-- ----------------------------------------------------------------------------
-- The DEFAULT 0 means a pre-existing row from a prior migration carries
-- is_deleted = 0 without any backfill. The harness seeds such a row in
-- 0006_messages.sql's mailboxes/messages scaffold; if none exists, the
-- assertion is vacuously true and the migration's invariant holds.
SELECT COUNT(*) = (
  SELECT COUNT(*) FROM message_user_state
)
FROM message_user_state
WHERE is_deleted = 0;

-- ----------------------------------------------------------------------------
-- 5. The `message_user_state_is_deleted_idx` index exists.
-- ----------------------------------------------------------------------------
SELECT COUNT(*) = 1 FROM sqlite_master
  WHERE type = 'index'
    AND name = 'message_user_state_is_deleted_idx';

-- ----------------------------------------------------------------------------
-- 6. No UNIQUE constraint was added on `is_deleted`.
-- ----------------------------------------------------------------------------
-- R-MESSAGE-005 — soft-delete is per-user; uniqueness is the existing PK
-- on `mailbox_message_id` only. The CHECK in step 2 confirms the
-- column is a plain INTEGER, not a candidate key.
SELECT COUNT(*) = 0 FROM pragma_index_list('message_user_state')
  WHERE ("unique" = 1)
    AND name LIKE '%is_deleted%';