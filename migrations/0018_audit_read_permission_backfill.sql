-- migrations/0018_audit_read_permission_backfill.sql
-- Upgrade closure for D-CAP-044-N.
--
-- Existing installations completed setup before `audit.read` joined the
-- permission enum. Add the permission unconditionally and grant it to the
-- system administrator role when that role already exists. On a fresh schema
-- the role is not created until setup; the setup seeder remains responsible
-- for inserting the role and its full permission mapping.

INSERT OR IGNORE INTO permissions (id, key, description, created_at)
VALUES ('audit.read', 'audit.read', 'Read audit events', datetime('now'));

INSERT OR IGNORE INTO role_permissions (role_id, permission_id, created_at)
SELECT 'administrator', 'audit.read', datetime('now')
WHERE EXISTS (SELECT 1 FROM roles WHERE id = 'administrator');

INSERT OR IGNORE INTO d1_migrations (name)
VALUES ('0018_audit_read_permission_backfill.sql');
