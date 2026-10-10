-- migrations/0023_message_user_state_star.sql — CAP-058.
--
-- Move the user-visible star state onto the existing per-user composite
-- state row. The legacy mailbox_messages.is_starred column remains for
-- compatibility only; reads and writes after this migration use
-- message_user_state.is_starred exclusively (R-MESSAGE-005).
--
-- Migration tracking (F1): the INSERT OR IGNORE keeps apply + track
-- idempotent and makes the tracking row part of the migration's D1 work.

-- 1. Add a typed boolean with a safe default for existing state rows.
ALTER TABLE message_user_state ADD COLUMN is_starred INTEGER NOT NULL DEFAULT 0
  CHECK (is_starred IN (0, 1));

-- 2. Preserve legacy mailbox-column stars for every effective mailbox user:
--    the implicit owner and every explicit member. UNION removes an owner
--    duplicate if bad legacy data also has an explicit member row. Existing
--    state rows are updated in place so their read/delete state is preserved.
INSERT INTO message_user_state (
  mailbox_message_id, user_id, is_read, read_at, updated_at,
  is_deleted, deleted_at, is_starred
)
SELECT mailbox_message_id, user_id, 0, NULL, datetime('now'), 0, NULL, 1
  FROM (
    SELECT mm.id AS mailbox_message_id,
           mb.owner_user_id AS user_id
      FROM mailbox_messages mm
      JOIN mailboxes mb ON mb.id = mm.mailbox_id
     WHERE mm.is_starred = 1
    UNION
    SELECT mm.id AS mailbox_message_id,
           members.user_id AS user_id
      FROM mailbox_messages mm
      JOIN mailbox_members members ON members.mailbox_id = mm.mailbox_id
     WHERE mm.is_starred = 1
  ) AS starred_users
 WHERE starred_users.mailbox_message_id IS NOT NULL
ON CONFLICT(mailbox_message_id, user_id) DO UPDATE SET
  is_starred = 1;

-- 3. Migration tracking — atomic with the schema change and backfill.
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0023_message_user_state_star.sql');
