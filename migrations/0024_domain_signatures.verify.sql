-- migrations/0024_domain_signatures.verify.sql — CAP-068 verification.

SELECT '0024_tracking_row_exists' AS assertion,
  COUNT(*) = 1 AS pass
FROM d1_migrations WHERE name = '0024_domain_signatures.sql';

SELECT '0024_table_exists' AS assertion,
  COUNT(*) = 1 AS pass
FROM sqlite_master WHERE type = 'table' AND name = 'domain_signatures';

SELECT '0024_columns_present' AS assertion,
  (SELECT COUNT(*) FROM pragma_table_info('domain_signatures')
   WHERE name IN ('id', 'domain_id', 'html_content', 'text_content', 'is_enabled', 'created_at', 'updated_at')) = 7 AS pass;

SELECT '0024_domain_unique_index' AS assertion,
  COUNT(*) = 1 AS pass
FROM sqlite_master WHERE type = 'index' AND name = 'domain_signatures_domain_unique';

SELECT '0024_foreign_key_cascades' AS assertion,
  COUNT(*) = 1 AS pass
FROM pragma_foreign_key_list('domain_signatures')
WHERE "table" = 'managed_domains' AND on_delete = 'CASCADE';

SELECT '0024_enabled_check' AS assertion,
  EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'domain_signatures'
      AND instr(sql, 'is_enabled IN (0, 1)') > 0
  ) AS pass;

SELECT '0024_content_checks' AS assertion,
  EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'domain_signatures'
      AND instr(sql, 'length(html_content) <= 100000') > 0
      AND instr(sql, 'length(text_content) <= 100000') > 0
  ) AS pass;
