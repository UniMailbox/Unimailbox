-- migrations/0009_idempotency_records.verify.sql — Verification queries for
-- 0009_idempotency_records.sql. Run after migration apply to confirm schema
-- integrity.
--
-- Verification checks:
-- 1. idempotency_records table exists with all 8 expected columns
-- 2. Unique index on (actor_id, operation, idempotency_key) exists
-- 3. Index on expires_at exists (TTL purge target)
-- 4. Length CHECKs on actor_id, operation, idempotency_key, request_hash,
--    response_json columns are present
-- 5. response_status is bounded to valid HTTP statuses (100-599)
-- 6. Migration tracking row recorded
-- 7. d1_migrations table exists

-- Verify idempotency_records table exists and has all 8 columns
SELECT COUNT(*) = 8 FROM pragma_table_info('idempotency_records')
WHERE name IN (
  'id', 'actor_id', 'operation', 'idempotency_key',
  'request_hash', 'response_status', 'response_json',
  'created_at', 'expires_at'
);

-- Verify unique index exists
SELECT COUNT(*) = 1 FROM sqlite_master
WHERE type='index' AND name='idempotency_records_unique';

-- Verify expires_at index exists (for daily purge cron — out of scope here
-- but the index must be present so the future cron is fast)
SELECT COUNT(*) = 1 FROM sqlite_master
WHERE type='index' AND name='idempotency_records_expires_at_idx';

-- Verify length CHECKs on opaque string columns
SELECT COUNT(*) = 5 FROM sqlite_master
WHERE type='table' AND name='idempotency_records'
  AND instr(sql, 'length(actor_id) <= 128') > 0
  AND instr(sql, 'length(operation) <= 128') > 0
  AND instr(sql, 'length(idempotency_key) <= 128') > 0
  AND instr(sql, 'length(request_hash) = 64') > 0
  AND instr(sql, 'length(response_json) <= 65536') > 0;

-- Verify response_status HTTP-range CHECK
SELECT COUNT(*) = 1 FROM sqlite_master
WHERE type='table' AND name='idempotency_records'
  AND instr(sql, 'response_status >= 100') > 0
  AND instr(sql, 'response_status < 600') > 0;

-- Verify migration tracking row exists
SELECT COUNT(*) = 1 FROM d1_migrations WHERE name = '0009_idempotency_records.sql';

-- Verify d1_migrations table itself exists (F1 invariant)
SELECT COUNT(*) = 1 FROM sqlite_master WHERE type='table' AND name='d1_migrations';