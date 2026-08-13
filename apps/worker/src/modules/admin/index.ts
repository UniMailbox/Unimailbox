// modules/admin — owner of roles, permissions, role_permissions, user_roles,
// system_settings, audit_events, maintenance_jobs.
//
// R-AUTHZ-001: Permissions are a closed enum (PermissionKey).
// R-AUTHZ-002: Authorization checks hit the database per request; no cache older than 5 minutes.
// R-AUTHZ-005: Admin identity comes from user_roles, never a flag on users.

export { checkPermission, getUserRoleIds } from './permission-repository';
export { seedRolesAndPermissions, assignRole } from './seed-repository';
