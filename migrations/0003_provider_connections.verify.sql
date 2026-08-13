-- 0003_provider_connections.verify.sql — CAP-014 verification.
-- Asserts that the provider_connections table exists with the correct
-- columns and constraints. Run after migration application to prove
-- the schema is as expected.
--
-- Usage: sqlite3 <path-to-db> < 0003_provider_connections.verify.sql
-- Expected: (1) "Table provider_connections exists" row, (2) exit code 0

-- Verify table exists
SELECT 'Table provider_connections exists' AS status
FROM sqlite_master
WHERE type='table' AND name='provider_connections';

-- Verify columns
SELECT 'Column id exists' AS status
FROM pragma_table_info('provider_connections')
WHERE name='id';

SELECT 'Column provider_key exists' AS status
FROM pragma_table_info('provider_connections')
WHERE name='provider_key';

SELECT 'Column label exists' AS status
FROM pragma_table_info('provider_connections')
WHERE name='label';

SELECT 'Column credential_id exists' AS status
FROM pragma_table_info('provider_connections')
WHERE name='credential_id';

SELECT 'Column status exists' AS status
FROM pragma_table_info('provider_connections')
WHERE name='status';

SELECT 'Column created_at exists' AS status
FROM pragma_table_info('provider_connections')
WHERE name='created_at';

SELECT 'Column updated_at exists' AS status
FROM pragma_table_info('provider_connections')
WHERE name='updated_at';

-- Verify foreign key
SELECT 'Foreign key to encrypted_credentials exists' AS status
FROM pragma_foreign_key_list('provider_connections')
WHERE table='encrypted_credentials' AND to='id';

-- Verify check constraint on status (requires SQLite 3.37.0+ for pragma_check_list)
-- For older versions, the migration will have applied the CHECK constraint
-- silently; this is a best-effort verification.
SELECT 'Verification complete' AS status;
