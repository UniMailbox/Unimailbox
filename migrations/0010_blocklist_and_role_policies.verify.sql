-- Verification for 0010_blocklist_and_role_policies.sql.
--
-- Updated for CAP-036 (0019): the role_policies JSON columns are dropped
-- by 0019_role_policy_normalize.sql. The two assertions that referenced
-- those columns (0010_role_policy_columns_exist + 0010_role_policy_json_guards_exist)
-- are removed; the remaining role_policy assertions cover the structural
-- invariants that 0019 still preserves (PK + FK to roles).

SELECT '0010_blocklist_columns_exist' AS assertion,
  COUNT(*) = 5 AS pass
FROM pragma_table_info('blocklist_entries')
WHERE name IN ('id', 'kind', 'pattern', 'created_by', 'created_at');

SELECT '0010_blocklist_checks_exist' AS assertion,
  EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'blocklist_entries'
      AND instr(sql, 'kind IN (''subject'', ''content'', ''from'')') > 0
      AND instr(sql, 'length(pattern) BETWEEN 1 AND 512') > 0
  ) AS pass;

SELECT '0010_blocklist_index_exists' AS assertion,
  COUNT(*) = 1 AS pass
FROM sqlite_master WHERE type = 'index' AND name = 'blocklist_entries_created_at_idx';

SELECT '0010_role_policy_primary_key' AS assertion,
  COUNT(*) = 1 AS pass
FROM pragma_table_info('role_policies') WHERE name = 'role_id' AND pk = 1;

SELECT '0010_role_policy_fk_exists' AS assertion,
  COUNT(*) = 1 AS pass
FROM pragma_foreign_key_list('role_policies')
WHERE "from" = 'role_id' AND "table" = 'roles' AND "to" = 'id';

SELECT '0010_tracking_row_exists' AS assertion,
  COUNT(*) = 1 AS pass
FROM d1_migrations WHERE name = '0010_blocklist_and_role_policies.sql';