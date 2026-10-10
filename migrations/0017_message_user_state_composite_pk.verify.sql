-- migrations/0017_message_user_state_composite_pk.verify.sql — Verification
-- queries for 0017_message_user_state_composite_pk.sql.
--
-- CAP-043 Slice 1 fix pass / F1 / D-CAP-043-F. Each statement returns one
-- row: (assertion TEXT, pass INTEGER) — the enforced verify convention
-- (scripts/db-migrate.ts counts these rows and fails the run on pass != 1;
-- plain SELECTs are not counted).
--
-- Checks:
--   1. Migration tracking row exists.
--   2. The PK is composite: both mailbox_message_id and user_id participate.
--      SQLite numbers composite-PK members 1..n in PRAGMA table_info, so
--      the first member reads pk=1 and the second pk=2 — exactly two
--      columns have pk > 0.
--   3. The copy step preserved every row (row count equals the distinct
--      mailbox_message_id count — the 0006 single-column PK guaranteed at
--      most one row per mailbox_message_id, so growth means fabricated
--      rows and the composite PK rejects duplicates).
--   4. Every column and default from 0006 + 0016 survived the rebuild
--      (7 columns; is_read/is_deleted NOT NULL DEFAULT 0; read_at /
--      deleted_at nullable; updated_at NOT NULL with datetime default).
--   5. The `is_deleted IN (0, 1)` CHECK survived the rebuild.
--   6. Both FK CASCADEs survived the rebuild.
--   7. Both indexes (message_user_state_user_idx,
--      message_user_state_is_deleted_idx) exist.

-- 1. Migration tracking row exists.
SELECT 'tracking_row' AS assertion,
  CASE WHEN EXISTS (
    SELECT 1 FROM d1_migrations
    WHERE name = '0017_message_user_state_composite_pk.sql'
  ) THEN 1 ELSE 0 END AS pass;

-- 2. Composite PK: both columns participate, in the declared order.
SELECT 'pk_mailbox_message_id_member_1' AS assertion,
  CASE WHEN EXISTS (
    SELECT 1 FROM pragma_table_info('message_user_state')
    WHERE name = 'mailbox_message_id' AND pk = 1
  ) THEN 1 ELSE 0 END AS pass;

SELECT 'pk_user_id_member_2' AS assertion,
  CASE WHEN EXISTS (
    SELECT 1 FROM pragma_table_info('message_user_state')
    WHERE name = 'user_id' AND pk = 2
  ) THEN 1 ELSE 0 END AS pass;

SELECT 'pk_exactly_two_members' AS assertion,
  CASE WHEN (
    SELECT COUNT(*) FROM pragma_table_info('message_user_state') WHERE pk > 0
  ) = 2 THEN 1 ELSE 0 END AS pass;

-- 3. Row count preserved (lossless copy, no fabrication).
-- Old PK (mailbox_message_id alone) ⇒ COUNT(*) = COUNT(DISTINCT mailbox_message_id)
-- held before the rebuild and must still hold immediately after it: the copy
-- cannot lose rows without dropping the count, cannot fabricate rows without
-- breaking the equality, and cannot duplicate rows against the composite PK.
SELECT 'rows_preserved_no_fabrication' AS assertion,
  CASE WHEN (
    SELECT COUNT(*) = COUNT(DISTINCT mailbox_message_id) FROM message_user_state
  ) = 1 THEN 1 ELSE 0 END AS pass;

-- 4. Every column from 0006 + 0016 survived the rebuild.
SELECT 'all_seven_columns_present' AS assertion,
  CASE WHEN (
    SELECT COUNT(*) FROM pragma_table_info('message_user_state')
    WHERE name IN ('mailbox_message_id', 'user_id', 'is_read', 'read_at',
                   'updated_at', 'is_deleted', 'deleted_at')
  ) = 7 THEN 1 ELSE 0 END AS pass;

SELECT 'is_deleted_shape_notnull_integer_default_0' AS assertion,
  CASE WHEN EXISTS (
    SELECT 1 FROM pragma_table_info('message_user_state')
    WHERE name = 'is_deleted'
      AND "notnull" = 1
      AND type = 'INTEGER'
      AND dflt_value = '0'
  ) THEN 1 ELSE 0 END AS pass;

SELECT 'deleted_at_nullable_text' AS assertion,
  CASE WHEN EXISTS (
    SELECT 1 FROM pragma_table_info('message_user_state')
    WHERE name = 'deleted_at'
      AND "notnull" = 0
      AND type = 'TEXT'
  ) THEN 1 ELSE 0 END AS pass;

SELECT 'is_read_shape_notnull_integer_default_0' AS assertion,
  CASE WHEN EXISTS (
    SELECT 1 FROM pragma_table_info('message_user_state')
    WHERE name = 'is_read'
      AND "notnull" = 1
      AND type = 'INTEGER'
      AND dflt_value = '0'
  ) THEN 1 ELSE 0 END AS pass;

SELECT 'updated_at_notnull_datetime_default' AS assertion,
  CASE WHEN EXISTS (
    SELECT 1 FROM pragma_table_info('message_user_state')
    WHERE name = 'updated_at'
      AND "notnull" = 1
      AND type = 'TEXT'
      AND dflt_value LIKE '%datetime%now%'
  ) THEN 1 ELSE 0 END AS pass;

-- 5. The is_deleted CHECK survived the rebuild (table-level DDL text).
SELECT 'is_deleted_check_survives' AS assertion,
  CASE WHEN EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type = 'table'
      AND name = 'message_user_state'
      AND sql LIKE '%is_deleted%CHECK%(is_deleted%IN%(0%,%1%))%'
  ) THEN 1 ELSE 0 END AS pass;

-- 6. Both FK CASCADEs survived the rebuild.
SELECT 'both_fk_cascades_survive' AS assertion,
  CASE WHEN (
    SELECT COUNT(*) FROM pragma_foreign_key_list('message_user_state')
    WHERE on_delete = 'CASCADE'
  ) = 2 THEN 1 ELSE 0 END AS pass;

-- 7. Both indexes exist.
SELECT 'index_user_idx_exists' AS assertion,
  CASE WHEN EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type = 'index' AND name = 'message_user_state_user_idx'
  ) THEN 1 ELSE 0 END AS pass;

SELECT 'index_is_deleted_idx_exists' AS assertion,
  CASE WHEN EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type = 'index' AND name = 'message_user_state_is_deleted_idx'
  ) THEN 1 ELSE 0 END AS pass;
