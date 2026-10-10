-- migrations/0011_message_event_time.sql — CAP-029 webhook ordering.
-- Adds provider_event_time to messages so R-MESSAGE-007 can decide whether
-- a webhook is newer than (or equal-but-higher-rank than) the status already
-- stored. Without a comparable timestamp, an out-of-order webhook (e.g.
-- 'delayed' arriving after 'delivered') could clobber the stored status.
--
-- Rules enforced:
--   R-MESSAGE-007: webhook status updates are applied only if the new
--     provider_event_time is strictly newer than the stored value, or equal
--     with a strictly higher status rank.
--   R-DATA-005: provider_event_time is INTEGER (Unix epoch ms) — typed,
--     indexable, comparable. NOT JSON-in-text.
--
-- Migration tracking (F1): the INSERT OR IGNORE INTO d1_migrations makes
-- apply+track atomic with the schema change.

ALTER TABLE messages ADD COLUMN provider_event_time INTEGER;

-- Index supports the rank-aware predicate's ORDER BY provider_event_time DESC
-- in any future read path that lists the most-recent event per message. The
-- writer in message-repository.updateMessageStatus does not need this index
-- (single-row UPDATE by primary key), but the predicate's `WHERE id = ? AND
-- (provider_event_time IS NULL OR provider_event_time < ?)` benefits from
-- the PK seek; the index is here for query plans that fan out.
CREATE INDEX IF NOT EXISTS messages_provider_event_time_idx
  ON messages(provider_event_time);

INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0011_message_event_time.sql');