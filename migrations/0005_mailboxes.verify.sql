-- Verification for 0005_mailboxes.sql.

SELECT '0005_tables_exist' AS assertion,
  COUNT(*) = 2 AS pass
FROM sqlite_master
WHERE type = 'table' AND name IN ('mailboxes', 'mailbox_members');

SELECT '0005_mailboxes_columns_exist' AS assertion,
  COUNT(*) = 9 AS pass
FROM pragma_table_info('mailboxes')
WHERE name IN ('id', 'domain_id', 'owner_user_id', 'local_part', 'display_name', 'status', 'created_at', 'updated_at', 'deleted_at');

SELECT '0005_mailbox_members_columns_exist' AS assertion,
  COUNT(*) = 4 AS pass
FROM pragma_table_info('mailbox_members')
WHERE name IN ('mailbox_id', 'user_id', 'role', 'created_at');

SELECT '0005_indexes_exist' AS assertion,
  COUNT(*) = 2 AS pass
FROM sqlite_master
WHERE type = 'index' AND name IN ('mailboxes_domain_local_unique', 'mailboxes_owner_idx');

SELECT '0005_member_composite_primary_key' AS assertion,
  SUM(name = 'mailbox_id' AND pk = 1) = 1
  AND SUM(name = 'user_id' AND pk = 2) = 1 AS pass
FROM pragma_table_info('mailbox_members');

SELECT '0005_foreign_keys_exist' AS assertion,
  (SELECT COUNT(*) FROM pragma_foreign_key_list('mailboxes')) = 2
  AND (SELECT COUNT(*) FROM pragma_foreign_key_list('mailbox_members') WHERE on_delete = 'CASCADE') = 2 AS pass;

SELECT '0005_tracking_row_exists' AS assertion,
  COUNT(*) = 1 AS pass
FROM d1_migrations WHERE name = '0005_mailboxes.sql';
