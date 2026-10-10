-- migrations/0020_idempotency_response_size.sql — CAP-047 draft PATCH slice.
--
-- Raise the `idempotency_records.response_json` CHECK from 65,536 to 524,288
-- so the GET-compatible PATCH replay body fits without rolling the
-- CHECK back. A PATCH that returns the full GET envelope with the
-- `body_html` field at its schema-legal maximum (131,072 chars) emits
-- a response_json well past the legacy 65,536 ceiling; the legacy
-- CHECK would cause a CHECK-constraint violation, rolling back the
-- whole atomic D1 batch (message UPDATE + recipients + audit +
-- idempotency). Rebuilding the table with the raised CHECK preserves
-- every column, every row, and both existing indexes.
--
-- The rebuild is the standard SQLite pattern (CREATE new, COPY, DROP
-- old, RENAME). SQLite cannot ALTER a CHECK constraint, so the
-- table-level DDL must be rewritten. The idempotency_records table has
-- no foreign keys (R-DATA-004 — only the actor_id/operation/idempotency_key
-- columns are populated, none reference another table), so DROP TABLE is
-- safe with PRAGMA foreign_keys = ON.
--
-- Why 524,288:
--   * body_html (max 131,072 chars) + body_text (max 65,536 chars) +
--     the rest of the GET envelope (~500 chars of overhead for keys,
--     timestamps, recipient arrays) lands well below 524,288.
--   * 524,288 = 512 KiB is a power-of-two ceiling that leaves headroom
--     for a future widening of the body limit ceilings while still
--     bounding the row size.
--   * The legacy 65,536 ceiling was sized for the COMPOSE route's
--     shorter response shape ({data: {messageId, status}}); the PATCH
--     envelope returns the full draft, so the same ceiling is too
--     small.
--
-- Rules enforced here:
--   R-API-004   Same-key + same-body replays return the stored response
--               byte-identically; same-key + different-body returns 409
--               IDEMPOTENCY_KEY_REUSED. The CHECK ceiling does NOT
--               weaken these — every replay still has to be byte-
--               identical to the stored body, and the 524,288 ceiling
--               is below the maximum a schema-legal draft can produce.
--   R-DATA-004  PRAGMA foreign_keys = ON is unchanged. The rebuild
--               preserves all columns and indexes.
--
-- Migration tracking (F1): the INSERT OR IGNORE INTO d1_migrations
-- makes apply+track atomic with the schema change.

-- ============================================================================
-- 1. Rebuild idempotency_records with the raised response_json CHECK.
-- ============================================================================
--
-- Column order, types, defaults, and the remaining CHECK constraints are
-- carried over verbatim from migrations/0009_idempotency_records.sql —
-- the only delta is `length(response_json) <= 524288` (was 65536).

CREATE TABLE idempotency_records_new (
  id               TEXT    PRIMARY KEY,
  actor_id         TEXT    NOT NULL CHECK (length(actor_id) <= 128),
  operation        TEXT    NOT NULL CHECK (length(operation) <= 128),
  idempotency_key  TEXT    NOT NULL CHECK (length(idempotency_key) <= 128),
  request_hash     TEXT    NOT NULL CHECK (length(request_hash) = 64),
  response_status  INTEGER NOT NULL CHECK (response_status >= 100 AND response_status < 600),
  response_json    TEXT    NOT NULL CHECK (length(response_json) <= 524288),
  created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at       TEXT    NOT NULL
);

INSERT INTO idempotency_records_new
  (id, actor_id, operation, idempotency_key, request_hash,
   response_json, response_status, created_at, expires_at)
SELECT id, actor_id, operation, idempotency_key, request_hash,
       response_json, response_status, created_at, expires_at
  FROM idempotency_records;

DROP TABLE idempotency_records;

ALTER TABLE idempotency_records_new RENAME TO idempotency_records;

-- ============================================================================
-- 2. Recreate both indexes (DROP TABLE dropped them with the old table).
-- ============================================================================
--
-- idempotency_records_unique is the per-actor dedup backbone — the
-- concurrent-request race relies on the UNIQUE constraint raising at
-- INSERT time. idempotency_records_expires_at_idx is the daily-cron
-- purge target. The route handler (platform/idempotency.ts) does not
-- need either for correctness today, but both are recreated to keep the
-- durable shape identical to pre-migration.

CREATE UNIQUE INDEX IF NOT EXISTS idempotency_records_unique
  ON idempotency_records(actor_id, operation, idempotency_key);

CREATE INDEX IF NOT EXISTS idempotency_records_expires_at_idx
  ON idempotency_records(expires_at);

-- ============================================================================
-- 3. Migration tracking — atomic with the schema change (F1).
-- ============================================================================
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0020_idempotency_response_size.sql');
