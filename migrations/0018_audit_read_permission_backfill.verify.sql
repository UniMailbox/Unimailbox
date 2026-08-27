-- Verification for 0018_audit_read_permission_backfill.sql.

SELECT '0018_audit_read_permission_exists' AS assertion,
  COUNT(*) = 1 AS pass
FROM permissions
WHERE id = 'audit.read' AND key = 'audit.read';

SELECT '0018_existing_administrator_has_audit_read' AS assertion,
  NOT EXISTS (SELECT 1 FROM roles WHERE id = 'administrator')
  OR EXISTS (
    SELECT 1 FROM role_permissions
    WHERE role_id = 'administrator' AND permission_id = 'audit.read'
  ) AS pass;

SELECT '0018_tracking_row_exists' AS assertion,
  COUNT(*) = 1 AS pass
FROM d1_migrations WHERE name = '0018_audit_read_permission_backfill.sql';
