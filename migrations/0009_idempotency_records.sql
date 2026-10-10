-- migrations/0009_idempotency_records.sql — CAP-027 ADR-004.
-- Adds idempotency_records for replay-safe client mutations.
--
-- Rules enforced:
--   R-API-004   Mutating endpoints accept Idempotency-Key; replays return the
--               stored response.
--   R-OUTBOUND-005  Send requests must include Idempotency-Key.
--   R-OUTBOUND-006  Send + queued job + idempotency record are in one D1 batch
--               (enforced by the route handler, not the schema — see
--               apps/worker/src/http/routes/compose.ts).
--   ADR-004 §Idempotency-keys: response_status + response_json stored; same
--               key + same hash replays the response; same key + different
--               hash → 409 IDEMPOTENCY_KEY_REUSED.
--
-- Migration tracking (F1): the INSERT OR IGNORE INTO d1_migrations makes
-- apply+track atomic with the schema change (see 0001_initial.md §F1).

CREATE TABLE IF NOT EXISTS idempotency_records (
  id               TEXT    PRIMARY KEY,
  actor_id         TEXT    NOT NULL CHECK (length(actor_id) <= 128),
  operation        TEXT    NOT NULL CHECK (length(operation) <= 128),
  idempotency_key  TEXT    NOT NULL CHECK (length(idempotency_key) <= 128),
  request_hash     TEXT    NOT NULL CHECK (length(request_hash) = 64),
  response_status  INTEGER NOT NULL CHECK (response_status >= 100 AND response_status < 600),
  response_json    TEXT    NOT NULL CHECK (length(response_json) <= 65536),
  created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at       TEXT    NOT NULL
);

-- Concurrent-request dedup: the second INSERT with the same (actor, op, key)
-- fails UNIQUE and the handler re-reads the row to replay the stored response.
CREATE UNIQUE INDEX IF NOT EXISTS idempotency_records_unique
  ON idempotency_records(actor_id, operation, idempotency_key);

-- Daily-cron purge target. expires_at rows > now() are expired and eligible
-- for deletion by a future capability (out of scope for CAP-027).
CREATE INDEX IF NOT EXISTS idempotency_records_expires_at_idx
  ON idempotency_records(expires_at);

INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0009_idempotency_records.sql');