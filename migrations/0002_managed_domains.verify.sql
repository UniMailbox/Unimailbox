-- migrations/0002_managed_domains.verify.sql — verification for 0002_managed_domains.sql.
-- Each statement returns one row: (assertion TEXT, pass INTEGER).
--   pass = 1 — assertion holds.
--   pass = 0 — assertion failed; the runner exits non-zero.
-- Statements are separated by `;` because D1's compound-select term
-- limit is smaller than the total number of assertions.
--
-- Idempotent: safe to re-run.

-- ============================================================
-- 1. Table exists
-- ============================================================
SELECT 'table_managed_domains' AS assertion,
  CASE WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='managed_domains') THEN 1 ELSE 0 END AS pass;

-- ============================================================
-- 2. managed_domains — columns present
-- ============================================================
SELECT 'managed_domains_has_id' AS assertion,
  CASE WHEN EXISTS (SELECT 1 FROM pragma_table_info('managed_domains') WHERE name='id') THEN 1 ELSE 0 END AS pass;
SELECT 'managed_domains_has_name' AS assertion,
  CASE WHEN EXISTS (SELECT 1 FROM pragma_table_info('managed_domains') WHERE name='name') THEN 1 ELSE 0 END AS pass;
SELECT 'managed_domains_has_status' AS assertion,
  CASE WHEN EXISTS (SELECT 1 FROM pragma_table_info('managed_domains') WHERE name='status') THEN 1 ELSE 0 END AS pass;
SELECT 'managed_domains_has_outbound_connection_id' AS assertion,
  CASE WHEN EXISTS (SELECT 1 FROM pragma_table_info('managed_domains') WHERE name='outbound_connection_id') THEN 1 ELSE 0 END AS pass;
SELECT 'managed_domains_has_created_at' AS assertion,
  CASE WHEN EXISTS (SELECT 1 FROM pragma_table_info('managed_domains') WHERE name='created_at') THEN 1 ELSE 0 END AS pass;
SELECT 'managed_domains_has_updated_at' AS assertion,
  CASE WHEN EXISTS (SELECT 1 FROM pragma_table_info('managed_domains') WHERE name='updated_at') THEN 1 ELSE 0 END AS pass;

-- ============================================================
-- 3. managed_domains — name COLLATE NOCASE (R-DATA-001)
-- ============================================================
SELECT 'managed_domains_name_collate_nocase' AS assertion,
  CASE WHEN EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type='table' AND name='managed_domains'
      AND instr(sql, 'name') > 0
      AND instr(sql, 'COLLATE NOCASE') > 0
      AND instr(substr(sql, instr(sql, 'name'), 80), 'NOT NULL') > 0
  ) THEN 1 ELSE 0 END AS pass;

-- ============================================================
-- 4. managed_domains — status CHECK constraint
-- ============================================================
SELECT 'managed_domains_status_check' AS assertion,
  CASE WHEN EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type='table' AND name='managed_domains'
      AND instr(sql, 'status IN') > 0
      AND instr(sql, '''active''') > 0
      AND instr(sql, '''disabled''') > 0
  ) THEN 1 ELSE 0 END AS pass;

-- ============================================================
-- 5. managed_domains — name UNIQUE index (case-insensitive)
-- ============================================================
SELECT 'managed_domains_name_unique_index' AS assertion,
  CASE WHEN EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type='index' AND name='managed_domains_name_unique'
  ) THEN 1 ELSE 0 END AS pass;

-- ============================================================
-- 6. d1_migrations tracking — 0002 recorded
-- ============================================================
SELECT 'd1_migrations_0002_recorded' AS assertion,
  CASE WHEN EXISTS (
    SELECT 1 FROM d1_migrations WHERE name = '0002_managed_domains.sql'
  ) THEN 1 ELSE 0 END AS pass;
