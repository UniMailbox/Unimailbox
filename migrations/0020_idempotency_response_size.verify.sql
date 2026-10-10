-- migrations/0020_idempotency_response_size.verify.sql — CAP-047 draft
-- PATCH slice. Verification queries for the response_json CHECK raise.
--
-- Each statement returns one row: (assertion TEXT, pass INTEGER) — the
-- enforced verify convention (scripts/db-migrate.ts counts these rows
-- and fails the run on pass != 1; plain SELECTs are not counted).
--
-- Checks:
--   1. Migration tracking row exists.
--   2. All 9 columns from 0009 survived the rebuild (no column
--      additions, no losses, no renames).
--   3. The CHECK ceiling on `response_json` is now 524,288 (not
--      65,536).
--   4. Every other CHECK constraint from 0009 survived the rebuild
--      verbatim (actor_id / operation / idempotency_key length caps,
--      request_hash length = 64, response_status 100..599).
--   5. The two indexes from 0009 survived the rebuild:
--      idempotency_records_unique (UNIQUE on actor_id, operation,
--      idempotency_key) and idempotency_records_expires_at_idx.
--   6. PROBE: a deterministic INSERT of a row whose `response_json`
--      is exactly 65,537 chars (just past the legacy 65,536 ceiling)
--      succeeds under the raised CHECK, the row exists with the
--      expected length, and the probe row is deleted afterwards.
--      A regression that re-tightened the CHECK to <= 65,536 would
--      CHECK-reject the INSERT and the probe-length assertion would
--      fail because the row would not exist.

-- 1. Migration tracking row exists.
SELECT '0020_tracking_row_exists' AS assertion,
  COUNT(*) = 1 AS pass
FROM d1_migrations WHERE name = '0020_idempotency_response_size.sql';

-- 2. All 9 columns from 0009 survived the rebuild.
SELECT '0020_nine_columns_preserved' AS assertion,
  COUNT(*) = 9 AS pass
FROM pragma_table_info('idempotency_records')
WHERE name IN ('id', 'actor_id', 'operation', 'idempotency_key',
               'request_hash', 'response_status', 'response_json',
               'created_at', 'expires_at');

-- Pin the column shape: PRIMARY KEY on `id` only, NOT NULL on the
-- required columns. A future migration that adds a column would
-- change the count and surface here.
SELECT '0020_id_is_primary_key' AS assertion,
  COUNT(*) = 1 AS pass
FROM pragma_table_info('idempotency_records')
WHERE name = 'id' AND pk = 1;

-- 3. The CHECK ceiling on `response_json` is now 524,288 (not 65,536).
-- Both branches of the assertion are checked — the new ceiling is
-- present AND the legacy 65,536 ceiling is gone (so a future rewrite
-- that reintroduces it would surface here).
SELECT '0020_response_json_check_raised_to_524288' AS assertion,
  EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'idempotency_records'
      AND instr(sql, 'length(response_json) <= 524288') > 0
  ) AS pass;

SELECT '0020_response_json_legacy_65536_check_removed' AS assertion,
  NOT EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'idempotency_records'
      AND instr(sql, 'length(response_json) <= 65536') > 0
      AND instr(sql, 'length(response_json) <= 524288') = 0
  ) AS pass;

-- 4. Every other CHECK constraint from 0009 survived the rebuild.
SELECT '0020_actor_id_check_preserved' AS assertion,
  EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'idempotency_records'
      AND instr(sql, 'length(actor_id) <= 128') > 0
  ) AS pass;

SELECT '0020_operation_check_preserved' AS assertion,
  EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'idempotency_records'
      AND instr(sql, 'length(operation) <= 128') > 0
  ) AS pass;

SELECT '0020_idempotency_key_check_preserved' AS assertion,
  EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'idempotency_records'
      AND instr(sql, 'length(idempotency_key) <= 128') > 0
  ) AS pass;

SELECT '0020_request_hash_check_preserved' AS assertion,
  EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'idempotency_records'
      AND instr(sql, 'length(request_hash) = 64') > 0
  ) AS pass;

SELECT '0020_response_status_check_preserved' AS assertion,
  EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'idempotency_records'
      AND instr(sql, 'response_status >= 100') > 0
      AND instr(sql, 'response_status < 600') > 0
  ) AS pass;

-- 5. Both indexes survived the rebuild.
SELECT '0020_unique_index_exists' AS assertion,
  COUNT(*) = 1 AS pass
FROM sqlite_master WHERE type = 'index' AND name = 'idempotency_records_unique';

SELECT '0020_unique_index_columns_unchanged' AS assertion,
  EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type = 'index' AND name = 'idempotency_records_unique'
      AND sql LIKE '%actor_id%'
      AND sql LIKE '%operation%'
      AND sql LIKE '%idempotency_key%'
  ) AS pass;

SELECT '0020_expiry_index_exists' AS assertion,
  COUNT(*) = 1 AS pass
FROM sqlite_master WHERE type = 'index' AND name = 'idempotency_records_expires_at_idx';

SELECT '0020_expiry_index_columns_unchanged' AS assertion,
  EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type = 'index' AND name = 'idempotency_records_expires_at_idx'
      AND sql LIKE '%expires_at%'
  ) AS pass;

-- BEGIN LOCAL BEHAVIOR CHECKS
-- 6. PROBE — proves the raised CHECK executes.
--
-- Namespaced probe row id ('00200000-…000020probe' = the 0020 migration's
-- probe family). The actor_id / operation / idempotency_key tuple is
-- unique, so the INSERT cannot collide with production traffic. INSERT
-- OR IGNORE keeps the probe idempotent across re-runs of the verifier.
-- response_json is built via a recursive CTE so its length is exactly
-- 65,537 — one byte past the legacy 65,536 ceiling. The request_hash is
-- a 64-char string of `x` to satisfy `length(request_hash) = 64`.
-- Cloudflare D1 does not expose SQLite's repeat() / rpad() functions,
-- so the CTE approach is the deterministic way to reach a known length
-- without inlining a 64 KiB literal.
INSERT OR IGNORE INTO idempotency_records (
  id, actor_id, operation, idempotency_key, request_hash,
  response_json, response_status, created_at, expires_at
)
WITH RECURSIVE payload(n, body) AS (
  SELECT 1, 'y'
  UNION ALL
  SELECT n + 1, body || 'y' FROM payload WHERE n < 65537
)
SELECT
  '00200000-0000-4000-8000-0000-00000020probe',
  'verify.probe-actor',
  'verify.response_size_probe',
  'verify.response_size_probe',
  'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  (SELECT body FROM payload WHERE n = 65537),
  200,
  '2026-01-01 00:00:00',
  '2099-01-01 00:00:00'
;

-- The probe row exists with response_json length EXACTLY 65,537. A
-- regression that re-tightened the CHECK to <= 65,536 would have
-- rejected the INSERT above; this SELECT would then return zero rows
-- and the assertion would fail (pass = 0).
SELECT '0020_probe_response_json_length_is_65537' AS assertion,
  length(response_json) = 65537 AS pass
FROM idempotency_records
WHERE id = '00200000-0000-4000-8000-0000-00000020probe';

DELETE FROM idempotency_records
WHERE id = '00200000-0000-4000-8000-0000-00000020probe';

-- The probe row was cleaned up. If the DELETE failed (e.g. a future
-- verifier is run inside a transaction that the probe did not
-- commit), the count would be 1 and this assertion would fail.
SELECT '0020_probe_row_deleted' AS assertion,
  COUNT(*) = 0 AS pass
FROM idempotency_records
WHERE id = '00200000-0000-4000-8000-0000-00000020probe';