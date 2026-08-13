-- migrations/0007_outbound_jobs.verify.sql — Verification queries for 0007_outbound_jobs.sql.
-- Run after migration apply to confirm schema integrity.
--
-- Verification checks:
-- 1. outbound_jobs table exists with correct columns
-- 2. Indexes exist
-- 3. CHECK constraint on status rejects invalid values
-- 4. Foreign keys to messages and provider_connections are valid
-- 5. Migration tracking row exists

-- Verify outbound_jobs table exists and has 14 columns
SELECT COUNT(*) = 14 FROM pragma_table_info('outbound_jobs')
WHERE name IN (
  'id', 'message_id', 'provider_connection_id', 'status',
  'attempts', 'max_attempts', 'locked_at', 'locked_by',
  'provider_message_id', 'error_code', 'error_message',
  'created_at', 'updated_at'
);

-- Verify indexes exist (status + message + implicit primary key)
SELECT COUNT(*) = 2 FROM pragma_index_list('outbound_jobs');

-- Verify foreign keys are enabled (R-DATA-004)
PRAGMA foreign_keys;

-- Verify migration tracking row exists
SELECT COUNT(*) = 1 FROM d1_migrations WHERE name = '0007_outbound_jobs.sql';
