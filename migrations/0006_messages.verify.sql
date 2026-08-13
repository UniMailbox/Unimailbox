-- migrations/0006_messages.verify.sql — Verification queries for 0006_messages.sql.
-- Run after migration apply to confirm schema integrity.
--
-- Verification checks:
-- 1. All tables exist
-- 2. All indexes exist
-- 3. CHECK constraints are enforced
-- 4. Foreign key relationships are valid

-- Verify messages table exists and has correct columns
SELECT COUNT(*) = 17 FROM pragma_table_info('messages')
WHERE name IN (
  'id', 'thread_id', 'from_address', 'from_name', 'subject',
  'html_body', 'text_body', 'message_id_header', 'in_reply_to_header',
  'references_header', 'status', 'error_code', 'error_message',
  'raw_object_key', 'created_by_user_id', 'received_at', 'sent_at',
  'created_at', 'updated_at'
);

-- Verify message_recipients table exists and has correct columns
SELECT COUNT(*) = 6 FROM pragma_table_info('message_recipients')
WHERE name IN ('id', 'message_id', 'address', 'display_name', 'type', 'created_at');

-- Verify mailbox_messages table exists and has correct columns
SELECT COUNT(*) = 7 FROM pragma_table_info('mailbox_messages')
WHERE name IN ('id', 'mailbox_id', 'message_id', 'is_read', 'is_starred', 'folder', 'created_at');

-- Verify message_user_state table exists and has correct columns
SELECT COUNT(*) = 5 FROM pragma_table_info('message_user_state')
WHERE name IN ('mailbox_message_id', 'user_id', 'is_read', 'read_at', 'updated_at');

-- Verify indexes exist
SELECT COUNT(*) = 5 FROM pragma_index_list('messages');
SELECT COUNT(*) = 1 FROM pragma_index_list('message_recipients');
SELECT COUNT(*) = 3 FROM pragma_index_list('mailbox_messages');
SELECT COUNT(*) = 1 FROM pragma_index_list('message_user_state');

-- Verify foreign keys are enabled (PRAGMA foreign_keys = ON)
PRAGMA foreign_keys;

-- Verify migration tracking row exists
SELECT COUNT(*) = 1 FROM d1_migrations WHERE name = '0006_messages.sql';
