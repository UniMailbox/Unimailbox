// modules/admin — owner of roles, permissions, role_permissions, user_roles,
// system_settings, audit_events, maintenance_jobs.
//
// R-AUTHZ-001: Permissions are a closed enum (PermissionKey).
// R-AUTHZ-002: Authorization checks hit the database per request; no cache older than 5 minutes.
// R-AUTHZ-005: Admin identity comes from user_roles, never a flag on users.

export { checkPermission, getUserRoleIds } from './permission-repository';
export { seedRolesAndPermissions, assignRole } from './seed-repository';
export {
  createAuditEvent,
  prepareCreateAuditEvent,
  type AuditEventInput,
} from './audit-event-repository';

// D-CAP-021 / CAP-035: blocklist + role policies.
export {
  createBlocklistEntry,
  prepareCreateBlocklistEntry,
  listBlocklistEntries,
  deleteBlocklistEntry,
  prepareDeleteBlocklistEntry,
  findBlocklistEntryById,
  createBlocklistReader,
  type CreateBlocklistEntryInput,
} from './blocklist-repository';
export {
  getRolePolicy,
  setRolePolicy,
  prepareSetRolePolicy,
  loadRolePoliciesForRoleIds,
  createRolePolicyReader,
  type SetRolePolicyInput,
} from './role-policy-repository';
