SELECT CASE
  WHEN (
    SELECT COUNT(*) FROM sqlite_schema WHERE type='table' AND name='message_embeddings'
  ) = 1
  AND (
    SELECT COUNT(*) FROM sqlite_schema WHERE type='index' AND name='idx_message_embeddings_mailbox'
  ) = 1
  AND (
    SELECT COUNT(*) FROM sqlite_schema WHERE type='index' AND name='idx_message_embeddings_embedded_at'
  ) = 1
  THEN 1
  ELSE 0
END AS message_embeddings_valid;
PRAGMA foreign_key_check;