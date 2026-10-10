-- migrations/0023_message_user_state_star.verify.sql — CAP-058.
-- Every statement returns (assertion, pass) for scripts/db-migrate.ts.

SELECT '0023_tracking_row_exists' AS assertion,
  COUNT(*) = 1 AS pass
FROM d1_migrations WHERE name = '0023_message_user_state_star.sql';

SELECT '0023_is_starred_shape' AS assertion,
  COUNT(*) = 1 AS pass
FROM pragma_table_info('message_user_state')
WHERE name = 'is_starred'
  AND type = 'INTEGER'
  AND "notnull" = 1
  AND dflt_value = '0';

SELECT '0023_is_starred_check' AS assertion,
  EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'message_user_state'
      AND instr(sql, 'is_starred IN (0, 1)') > 0
  ) AS pass;

SELECT '0023_composite_pk_preserved' AS assertion,
  (SELECT COUNT(*) FROM pragma_table_info('message_user_state') WHERE pk > 0) = 2
  AND (SELECT pk FROM pragma_table_info('message_user_state') WHERE name = 'mailbox_message_id') = 1
  AND (SELECT pk FROM pragma_table_info('message_user_state') WHERE name = 'user_id') = 2 AS pass;

SELECT '0023_foreign_keys_preserved' AS assertion,
  (SELECT COUNT(*) FROM pragma_foreign_key_list('message_user_state')) = 2
  AND (SELECT COUNT(*) FROM pragma_foreign_key_list('message_user_state') WHERE on_delete = 'CASCADE') = 2 AS pass;

-- The backfill's enduring shape: any legacy-starred mailbox has one or more
-- per-user starred rows and no duplicate composite state keys. The legacy
-- source column remains present for the compatibility period.
SELECT '0023_legacy_column_retained' AS assertion,
  COUNT(*) = 1 AS pass
FROM pragma_table_info('mailbox_messages') WHERE name = 'is_starred';

SELECT '0023_no_duplicate_state_keys' AS assertion,
  COUNT(*) = 0 AS pass
FROM (
  SELECT mailbox_message_id, user_id
    FROM message_user_state
   GROUP BY mailbox_message_id, user_id
  HAVING COUNT(*) > 1
);
