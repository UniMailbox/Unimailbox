-- Verification for 0006_messages.sql.

SELECT '0006_tables_exist' AS assertion,
  COUNT(*) = 4 AS pass
FROM sqlite_master
WHERE type = 'table' AND name IN ('messages', 'message_recipients', 'mailbox_messages', 'message_user_state');

SELECT '0006_messages_columns_exist' AS assertion,
  COUNT(*) = 19 AS pass
FROM pragma_table_info('messages')
WHERE name IN ('id', 'thread_id', 'from_address', 'from_name', 'subject', 'html_body', 'text_body', 'message_id_header', 'in_reply_to_header', 'references_header', 'status', 'error_code', 'error_message', 'raw_object_key', 'created_by_user_id', 'received_at', 'sent_at', 'created_at', 'updated_at');

SELECT '0006_recipient_columns_exist' AS assertion,
  COUNT(*) = 6 AS pass
FROM pragma_table_info('message_recipients')
WHERE name IN ('id', 'message_id', 'address', 'display_name', 'type', 'created_at');

SELECT '0006_mailbox_message_columns_exist' AS assertion,
  COUNT(*) = 7 AS pass
FROM pragma_table_info('mailbox_messages')
WHERE name IN ('id', 'mailbox_id', 'message_id', 'is_read', 'is_starred', 'folder', 'created_at');

SELECT '0006_user_state_base_columns_exist' AS assertion,
  COUNT(*) = 5 AS pass
FROM pragma_table_info('message_user_state')
WHERE name IN ('mailbox_message_id', 'user_id', 'is_read', 'read_at', 'updated_at');

SELECT '0006_named_indexes_exist' AS assertion,
  COUNT(*) = 8 AS pass
FROM sqlite_master
WHERE type = 'index' AND name IN (
  'messages_thread_id_idx', 'messages_from_address_idx', 'messages_status_idx',
  'messages_created_at_idx', 'message_recipients_message_idx',
  'mailbox_messages_mailbox_idx', 'mailbox_messages_message_idx',
  'message_user_state_user_idx'
);

SELECT '0006_foreign_keys_enabled' AS assertion,
  foreign_keys = 1 AS pass
FROM pragma_foreign_keys;

SELECT '0006_tracking_row_exists' AS assertion,
  COUNT(*) = 1 AS pass
FROM d1_migrations WHERE name = '0006_messages.sql';
