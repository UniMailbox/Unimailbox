-- Verification for 0019_role_policy_normalize.sql — CAP-036.
--
-- Enduring structural / current-schema invariants. Asserts the
-- post-migration shape; does not assume the dropped JSON columns
-- remain available.

-- 1. The migration is tracked.
SELECT '0019_tracking_row_exists' AS assertion,
  COUNT(*) = 1 AS pass
FROM d1_migrations WHERE name = '0019_role_policy_normalize.sql';

-- 2. role_policies has exactly the metadata columns — no legacy JSON.
SELECT '0019_role_policies_columns' AS assertion,
  (SELECT COUNT(*) FROM pragma_table_info('role_policies')) = 3
    AND (SELECT COUNT(*) FROM pragma_table_info('role_policies')
         WHERE name IN ('role_id', 'updated_by', 'updated_at')) = 3 AS pass;

SELECT '0019_role_policies_no_legacy_json' AS assertion,
  COUNT(*) = 0 AS pass
FROM pragma_table_info('role_policies')
WHERE name IN ('ban_email_patterns_json', 'avail_domain_patterns_json');

-- 3. role_policies.primary key is role_id.
SELECT '0019_role_policies_pk' AS assertion,
  COUNT(*) = 1 AS pass
FROM pragma_table_info('role_policies') WHERE name = 'role_id' AND pk = 1;

-- 4. role_policies.role_id → roles(id) ON DELETE CASCADE.
SELECT '0019_role_policies_fk' AS assertion,
  COUNT(*) = 1 AS pass
FROM pragma_foreign_key_list('role_policies')
WHERE "from" = 'role_id' AND "table" = 'roles' AND "to" = 'id'
  AND on_delete = 'CASCADE';

-- 5. Child table: role_policy_ban_emails exists with composite PK + FK + length check.
SELECT '0019_ban_emails_table' AS assertion,
  COUNT(*) = 1 AS pass
FROM sqlite_master WHERE type = 'table' AND name = 'role_policy_ban_emails';

SELECT '0019_ban_emails_pattern_check' AS assertion,
  EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'role_policy_ban_emails'
      AND instr(sql, 'CHECK (length(pattern) BETWEEN 1 AND 254)') > 0
  ) AS pass;

SELECT '0019_ban_emails_pk' AS assertion,
  (SELECT COUNT(*) FROM pragma_table_info('role_policy_ban_emails')) = 2
    AND (SELECT COUNT(*) FROM pragma_table_info('role_policy_ban_emails')
         WHERE name = 'role_id' AND pk = 1) = 1
    AND (SELECT COUNT(*) FROM pragma_table_info('role_policy_ban_emails')
         WHERE name = 'pattern' AND pk = 2) = 1 AS pass;

SELECT '0019_ban_emails_fk_cascade' AS assertion,
  COUNT(*) = 1 AS pass
FROM pragma_foreign_key_list('role_policy_ban_emails')
WHERE "from" = 'role_id' AND "table" = 'roles' AND "to" = 'id'
  AND on_delete = 'CASCADE';

-- 6. Child table: role_policy_avail_domains exists with composite PK + FK + length check.
SELECT '0019_avail_domains_table' AS assertion,
  COUNT(*) = 1 AS pass
FROM sqlite_master WHERE type = 'table' AND name = 'role_policy_avail_domains';

SELECT '0019_avail_domains_pattern_check' AS assertion,
  EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'role_policy_avail_domains'
      AND instr(sql, 'CHECK (length(pattern) BETWEEN 2 AND 254)') > 0
  ) AS pass;

SELECT '0019_avail_domains_pk' AS assertion,
  (SELECT COUNT(*) FROM pragma_table_info('role_policy_avail_domains')) = 2
    AND (SELECT COUNT(*) FROM pragma_table_info('role_policy_avail_domains')
         WHERE name = 'role_id' AND pk = 1) = 1
    AND (SELECT COUNT(*) FROM pragma_table_info('role_policy_avail_domains')
         WHERE name = 'pattern' AND pk = 2) = 1 AS pass;

SELECT '0019_avail_domains_fk_cascade' AS assertion,
  COUNT(*) = 1 AS pass
FROM pragma_foreign_key_list('role_policy_avail_domains')
WHERE "from" = 'role_id' AND "table" = 'roles' AND "to" = 'id'
  AND on_delete = 'CASCADE';

-- 7. Enduring data invariants for both child collections.
SELECT '0019_no_orphan_ban_emails' AS assertion,
  COUNT(*) = 0 AS pass
FROM role_policy_ban_emails AS child
LEFT JOIN roles AS parent ON parent.id = child.role_id
WHERE parent.id IS NULL;

SELECT '0019_no_orphan_avail_domains' AS assertion,
  COUNT(*) = 0 AS pass
FROM role_policy_avail_domains AS child
LEFT JOIN roles AS parent ON parent.id = child.role_id
WHERE parent.id IS NULL;

SELECT '0019_ban_email_lengths_valid' AS assertion,
  COUNT(*) = 0 AS pass
FROM role_policy_ban_emails
WHERE length(pattern) NOT BETWEEN 1 AND 254;

SELECT '0019_avail_domain_lengths_valid' AS assertion,
  COUNT(*) = 0 AS pass
FROM role_policy_avail_domains
WHERE length(pattern) NOT BETWEEN 2 AND 254;

SELECT '0019_no_duplicate_ban_emails' AS assertion,
  COUNT(*) = 0 AS pass
FROM (
  SELECT role_id, pattern
  FROM role_policy_ban_emails
  GROUP BY role_id, pattern
  HAVING COUNT(*) > 1
);

SELECT '0019_no_duplicate_avail_domains' AS assertion,
  COUNT(*) = 0 AS pass
FROM (
  SELECT role_id, pattern
  FROM role_policy_avail_domains
  GROUP BY role_id, pattern
  HAVING COUNT(*) > 1
);
