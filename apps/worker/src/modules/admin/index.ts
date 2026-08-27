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

// CAP-044 Slice 2 (D-CAP-044-E, CAP-033 absorbed): audit-event query API.
// Slice 2 fix pass: AuditRowInvalidError (fix (b), 500 AUDIT_ROW_INVALID
// on an out-of-enum stored row) and AuditFilterPairError (fix (c), half
// resource pair on the exported repository contract).
export {
  queryAuditEvents,
  AuditCursorInvalidError,
  AuditFilterPairError,
  AuditRowInvalidError,
  type AuditEventFilters,
  type AuditEventQueryResult,
} from './audit-query-repository';

// D-CAP-021 / CAP-035 / CAP-036: blocklist + role policies.
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
  loadRolePoliciesForRoleIds,
  prepareSetRolePolicyBatch,
  createRolePolicyReader,
  type SetRolePolicyInput,
} from './role-policy-repository';

// CAP-040: cross-module write seam for audit_events. Mirrors the
// BlocklistReader / RolePolicyReader read seams; only the writer is
// wired through AppContext.
export { createAuditEventWriter } from './audit-event-writer';
