-- migrations/0010_blocklist_and_role_policies.verify.sql — Verification queries for
-- 0010_blocklist_and_role_policies.sql. Run after migration apply to confirm schema
-- integrity.
--
-- Verification checks:
-- 1. blocklist_entries table exists with all 5 expected columns
-- 2. blocklist_entries.kind CHECK constraint limits to 'subject' | 'content' | 'from'
-- 3. blocklist_entries.pattern length CHECK is between 1 and 512
-- 4. blocklist_entries.created_at index exists
-- 5. role_policies table exists with all 5 expected columns
-- 6. role_policies.role_id is a PRIMARY KEY with FK to roles(id)
-- 7. role_policies JSON columns default to '[]' with bounded length
-- 8. Migration tracking row recorded

-- Verify blocklist_entries table exists and has all 5 columns
SELECT COUNT(*) = 5 FROM pragma_table_info('blocklist_entries')
WHERE name IN ('id', 'kind', 'pattern', 'created_by', 'created_at');

-- Verify kind CHECK constraint
SELECT COUNT(*) = 1 FROM sqlite_master
WHERE type='table' AND name='blocklist_entries'
  AND instr(sql, "'subject'") > 0
  AND instr(sql, "'content'") > 0
  AND instr(sql, "'from'") > 0;

-- Verify pattern length CHECK
SELECT COUNT(*) = 1 FROM sqlite_master
WHERE type='table' AND name='blocklist_entries'
  AND instr(sql, 'length(pattern) BETWEEN 1 AND 512') > 0;

-- Verify created_at index exists
SELECT COUNT(*) = 1 FROM sqlite_master
WHERE type='index' AND name='blocklist_entries_created_at_idx';

-- Verify role_policies table exists with all 5 columns
SELECT COUNT(*) = 5 FROM pragma_table_info('role_policies')
WHERE name IN ('role_id', 'ban_email_patterns_json', 'avail_domain_patterns_json', 'updated_by', 'updated_at');

-- Verify role_policies.role_id is PRIMARY KEY with FK to roles(id)
SELECT COUNT(*) = 1 FROM sqlite_master
WHERE type='table' AND name='role_policies'
  AND instr(sql, 'role_id') > 0
  AND instr(sql, 'PRIMARY KEY') > 0
  AND instr(sql, 'REFERENCES roles(id)') > 0;

-- Verify JSON columns have length CHECK and default '[]'
SELECT COUNT(*) = 2 FROM sqlite_master
WHERE type='table' AND name='role_policies'
  AND instr(sql, "length(ban_email_patterns_json) <= 65536") > 0
  AND instr(sql, "length(avail_domain_patterns_json) <= 65536") > 0
  AND instr(sql, "DEFAULT '[]'") > 0;

-- Verify migration tracking row exists
SELECT COUNT(*) = 1 FROM d1_migrations WHERE name = '0010_blocklist_and_role_policies.sql';

-- Verify d1_migrations table itself exists (F1 invariant)
SELECT COUNT(*) = 1 FROM sqlite_master WHERE type='table' AND name='d1_migrations';