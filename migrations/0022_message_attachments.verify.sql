-- migrations/0022_message_attachments.verify.sql — CAP-050.
-- Every statement returns (assertion, pass) for scripts/db-migrate.ts.

SELECT '0022_tracking_row_exists' AS assertion,
  COUNT(*) = 1 AS pass
FROM d1_migrations WHERE name = '0022_message_attachments.sql';

SELECT '0022_table_exists' AS assertion,
  COUNT(*) = 1 AS pass
FROM sqlite_master WHERE type = 'table' AND name = 'message_attachments';

SELECT '0022_columns_complete' AS assertion,
  COUNT(*) = 11 AS pass
FROM pragma_table_info('message_attachments')
WHERE name IN ('id', 'message_id', 'upload_id', 'object_key', 'filename',
               'content_type', 'size_bytes', 'disposition', 'content_id',
               'sha256', 'created_at');

SELECT '0022_message_fk_cascades' AS assertion,
  COUNT(*) = 1 AS pass
FROM pragma_foreign_key_list('message_attachments')
WHERE "from" = 'message_id' AND "table" = 'messages' AND "to" = 'id'
  AND on_delete = 'CASCADE';

SELECT '0022_upload_fk_restricts' AS assertion,
  COUNT(*) = 1 AS pass
FROM pragma_foreign_key_list('message_attachments')
WHERE "from" = 'upload_id' AND "table" = 'attachment_uploads' AND "to" = 'id'
  AND on_delete = 'RESTRICT';

SELECT '0022_upload_unique_index' AS assertion,
  COUNT(*) = 1 AS pass
FROM pragma_index_list('message_attachments')
WHERE name = 'message_attachments_upload_unique' AND "unique" = 1;

SELECT '0022_message_index_exists' AS assertion,
  COUNT(*) = 1 AS pass
FROM sqlite_master
WHERE type = 'index' AND name = 'message_attachments_message_idx';

SELECT '0022_constraints_present' AS assertion,
  instr(sql, "object_key = 'attachment:' || upload_id") > 0
  AND instr(sql, "disposition IN ('attachment', 'inline')") > 0
  AND instr(sql, 'size_bytes BETWEEN 1 AND 5242880') > 0
  AND instr(sql, 'length(sha256) = 64') > 0 AS pass
FROM sqlite_master WHERE type = 'table' AND name = 'message_attachments';

SELECT '0022_nullable_columns' AS assertion,
  (SELECT "notnull" FROM pragma_table_info('message_attachments')
   WHERE name = 'content_id') = 0
  AND (SELECT "notnull" FROM pragma_table_info('message_attachments')
       WHERE name = 'sha256') = 0 AS pass;

SELECT '0022_consumable_trigger_exists' AS assertion,
  COUNT(*) = 1 AS pass
FROM sqlite_master
WHERE type = 'trigger' AND name = 'message_attachments_upload_consumable'
  AND tbl_name = 'message_attachments'
  AND instr(sql, 'ATTACHMENT_UPLOAD_NOT_CONSUMABLE') > 0
  AND instr(sql, "status = 'uploaded'") > 0;

SELECT '0022_consumable_trigger_ownership' AS assertion,
  COUNT(*) = 1 AS pass
FROM sqlite_master
WHERE type = 'trigger' AND name = 'message_attachments_upload_consumable'
  -- R-AUTHZ-004 + R-ATTACHMENT-001: upload owner must equal message creator.
  AND instr(sql, 'au.owner_user_id = m.created_by_user_id') > 0
  -- The JOIN against `messages` enforces `messages.id = NEW.message_id`
  -- implicitly and gives the trigger access to `created_by_user_id`.
  AND instr(sql, 'JOIN messages m ON m.id = NEW.message_id') > 0
  -- R-DATA-005: canonical filename must match the upload row.
  AND instr(sql, 'au.filename = NEW.filename') > 0
  -- R-DATA-005: canonical content_type must match the upload row.
  AND instr(sql, 'au.content_type = NEW.content_type') > 0
  -- R-DATA-005: canonical disposition must match the upload row.
  AND instr(sql, 'au.disposition = NEW.disposition') > 0
  -- kv_key / size_bytes round-trip guards so the queue consumer cannot
  -- read bytes from a key the upload row never wrote to.
  AND instr(sql, 'au.kv_key = NEW.object_key') > 0
  AND instr(sql, 'au.size_bytes = NEW.size_bytes') > 0
  -- R-ATTACHMENT-005 + R-ATTACHMENT-007: live + not expired.
  AND instr(sql, "au.status = 'uploaded'") > 0
  AND instr(sql, "au.expires_at > datetime('now')") > 0;

SELECT '0022_consume_once_trigger_exists' AS assertion,
  COUNT(*) = 1 AS pass
FROM sqlite_master
WHERE type = 'trigger' AND name = 'attachment_uploads_consume_once'
  AND tbl_name = 'attachment_uploads'
  AND instr(sql, 'ATTACHMENT_UPLOAD_ALREADY_CONSUMED') > 0;