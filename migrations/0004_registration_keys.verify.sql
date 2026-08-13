-- 0004_registration_keys.verify.sql — Verify registration_keys table structure.
-- Assertions run after migration to confirm the schema is as intended.
-- These assertions are executed by the migration verify system.

-- Verify the table exists
SELECT 'registration_keys table exists' AS assertion
FROM sqlite_master
WHERE type = 'table' AND name = 'registration_keys';

-- Verify all required columns exist
SELECT 'registration_keys has id column' AS assertion
FROM pragma_table_info('registration_keys')
WHERE name = 'id';

SELECT 'registration_keys has code_hash column' AS assertion
FROM pragma_table_info('registration_keys')
WHERE name = 'code_hash';

SELECT 'registration_keys has role_id column' AS assertion
FROM pragma_table_info('registration_keys')
WHERE name = 'role_id';

SELECT 'registration_keys has max_uses column' AS assertion
FROM pragma_table_info('registration_keys')
WHERE name = 'max_uses';

SELECT 'registration_keys has used_count column' AS assertion
FROM pragma_table_info('registration_keys')
WHERE name = 'used_count';

SELECT 'registration_keys has expires_at column' AS assertion
FROM pragma_table_info('registration_keys')
WHERE name = 'expires_at';

SELECT 'registration_keys has revoked_at column' AS assertion
FROM pragma_table_info('registration_keys')
WHERE name = 'revoked_at';

SELECT 'registration_keys has created_by column' AS assertion
FROM pragma_table_info('registration_keys')
WHERE name = 'created_by';

SELECT 'registration_keys has created_at column' AS assertion
FROM pragma_table_info('registration_keys')
WHERE name = 'created_at';

-- Verify max_uses CHECK constraint exists
SELECT 'registration_keys has max_uses check constraint' AS assertion
FROM sqlite_master
WHERE type = 'table' AND name = 'registration_keys'
  AND sql LIKE '%CHECK (max_uses >= 1)%';
