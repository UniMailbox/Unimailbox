-- migrations/0021_attachment_uploads.verify.sql — CAP-049.
-- Every statement returns (assertion, pass) for scripts/db-migrate.ts.

SELECT '0021_tracking_row_exists' AS assertion,
  COUNT(*) = 1 AS pass
FROM d1_migrations WHERE name = '0021_attachment_uploads.sql';

SELECT '0021_table_exists' AS assertion,
  COUNT(*) = 1 AS pass
FROM sqlite_master WHERE type = 'table' AND name = 'attachment_uploads';

SELECT '0021_columns_complete' AS assertion,
  COUNT(*) = 12 AS pass
FROM pragma_table_info('attachment_uploads')
WHERE name IN ('id', 'owner_user_id', 'mailbox_id', 'kv_key', 'filename',
               'content_type', 'disposition', 'size_bytes', 'status', 'expires_at',
               'consumed_at', 'created_at');

SELECT '0021_owner_fk_cascades' AS assertion,
  COUNT(*) = 1 AS pass
FROM pragma_foreign_key_list('attachment_uploads')
WHERE "from" = 'owner_user_id' AND "table" = 'users' AND "to" = 'id'
  AND on_delete = 'CASCADE';

SELECT '0021_mailbox_fk_cascades' AS assertion,
  COUNT(*) = 1 AS pass
FROM pragma_foreign_key_list('attachment_uploads')
WHERE "from" = 'mailbox_id' AND "table" = 'mailboxes' AND "to" = 'id'
  AND on_delete = 'CASCADE';

SELECT '0021_kv_key_unique' AS assertion,
  COUNT(*) = 1 AS pass
FROM pragma_index_list('attachment_uploads')
WHERE name = 'attachment_uploads_kv_key_unique' AND "unique" = 1;

SELECT '0021_indexes_exist' AS assertion,
  COUNT(*) = 3 AS pass
FROM sqlite_master
WHERE type = 'index' AND name IN (
  'attachment_uploads_owner_idx',
  'attachment_uploads_mailbox_idx',
  'attachment_uploads_expires_at_idx'
);

SELECT '0021_constraints_present' AS assertion,
  instr(sql, 'size_bytes BETWEEN 1 AND 5242880') > 0
  AND instr(sql, "status IN ('uploaded', 'consumed', 'expired')") > 0
  AND instr(sql, "disposition IN ('attachment', 'inline')") > 0
  AND instr(sql, "kv_key = 'attachment:' || id") > 0 AS pass
FROM sqlite_master WHERE type = 'table' AND name = 'attachment_uploads';

SELECT '0021_disposition_default_and_consumed_at_nullable' AS assertion,
  (SELECT dflt_value FROM pragma_table_info('attachment_uploads')
   WHERE name = 'disposition') = "'attachment'"
  AND (SELECT "notnull" FROM pragma_table_info('attachment_uploads')
       WHERE name = 'consumed_at') = 0 AS pass;
