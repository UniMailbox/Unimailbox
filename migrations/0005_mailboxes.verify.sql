-- 0005_mailboxes.verify.sql
-- CAP-020: Verify mailboxes and mailbox_members tables

-- Verify mailboxes table structure
SELECT
  'mailboxes.id' as column_name,
  type,
  "notnull" as is_not_null,
  pk as is_primary_key
FROM pragma_table_info('mailboxes')
WHERE name = 'id'
UNION ALL
SELECT
  'mailboxes.domain_id',
  type,
  "notnull",
  pk
FROM pragma_table_info('mailboxes')
WHERE name = 'domain_id'
UNION ALL
SELECT
  'mailboxes.owner_user_id',
  type,
  "notnull",
  pk
FROM pragma_table_info('mailboxes')
WHERE name = 'owner_user_id'
UNION ALL
SELECT
  'mailboxes.local_part',
  type,
  "notnull",
  pk
FROM pragma_table_info('mailboxes')
WHERE name = 'local_part'
UNION ALL
SELECT
  'mailboxes.display_name',
  type,
  "notnull",
  pk
FROM pragma_table_info('mailboxes')
WHERE name = 'display_name'
UNION ALL
SELECT
  'mailboxes.status',
  type,
  "notnull",
  pk
FROM pragma_table_info('mailboxes')
WHERE name = 'status'
UNION ALL
SELECT
  'mailboxes.created_at',
  type,
  "notnull",
  pk
FROM pragma_table_info('mailboxes')
WHERE name = 'created_at'
UNION ALL
SELECT
  'mailboxes.updated_at',
  type,
  "notnull",
  pk
FROM pragma_table_info('mailboxes')
WHERE name = 'updated_at'
UNION ALL
SELECT
  'mailboxes.deleted_at',
  type,
  "notnull",
  pk
FROM pragma_table_info('mailboxes')
WHERE name = 'deleted_at';

-- Verify mailboxes_domain_local_unique index exists
SELECT name FROM pragma_index_list('mailboxes') WHERE name = 'mailboxes_domain_local_unique';

-- Verify mailboxes_owner_idx index exists
SELECT name FROM pragma_index_list('mailboxes') WHERE name = 'mailboxes_owner_idx';

-- Verify mailbox_members table structure
SELECT
  'mailbox_members.mailbox_id' as column_name,
  type,
  "notnull" as is_not_null,
  pk as is_primary_key
FROM pragma_table_info('mailbox_members')
WHERE name = 'mailbox_id'
UNION ALL
SELECT
  'mailbox_members.user_id',
  type,
  "notnull",
  pk
FROM pragma_table_info('mailbox_members')
WHERE name = 'user_id'
UNION ALL
SELECT
  'mailbox_members.role',
  type,
  "notnull",
  pk
FROM pragma_table_info('mailbox_members')
WHERE name = 'role'
UNION ALL
SELECT
  'mailbox_members.created_at',
  type,
  "notnull",
  pk
FROM pragma_table_info('mailbox_members')
WHERE name = 'created_at';

-- Verify mailbox_members composite primary key
SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'mailbox_members';
